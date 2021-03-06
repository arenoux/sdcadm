/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var util = require('util'),
    format = util.format;
var path = require('path');
var fs = require('fs');

var vasync = require('vasync');
var once = require('once');
var mkdirp = require('mkdirp');
var assert = require('assert-plus');
var ProgressBar = require('progbar').ProgressBar;
var uuid = require('node-uuid');

var common = require('../common');
var errors = require('../errors');
var DownloadImages = require('../procedures/download-images').DownloadImages;
var shared = require('../procedures/shared');
var steps = require('../steps');
var ur = require('../ur');

/**
 * SDC docker service setup
 */

function do_docker(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        return cb(new errors.UsageError('too many args: ' + args));
    }

    var start = Date.now();
    var headnode;
    var dockerSvcData = {
        name: 'docker',
        params: {
            package_name: 'sdc_4096',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: true,
            maintain_resolvers: true,
            networks: [
                {name: 'admin'},
                {name: 'external', primary: true}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'docker',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: 'docker',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            USE_TLS: true,
            'user-script': 'TO_FILL_IN'
        }
    };

    var context = {
        imgsToDownload: [],
        downloadDir: '/var/tmp'
    };
    vasync.pipeline({arg: context, funcs: [
        /* @field ctx.dockerPkg */
        function getDockerPkg(ctx, next) {
            var filter = {name: dockerSvcData.params.package_name,
                active: true};
            self.sdcadm.papi.list(filter, {}, function (err, pkgs) {
                if (err) {
                    return next(err);
                } else if (pkgs.length !== 1) {
                    return next(new errors.InternalError({
                        message: format('%d "%s" packages found', pkgs.length,
                            dockerSvcData.params.package_name)
                    }));
                }
                ctx.dockerPkg = pkgs[0];
                next();
            });
        },

        function ensureSapiMode(_, next) {
            // Bail if SAPI not in 'full' mode.
            self.sdcadm.sapi.getMode(function (err, mode) {
                if (err) {
                    next(new errors.SDCClientError(err, 'sapi'));
                } else if (mode !== 'full') {
                    next(new errors.UpdateError(format(
                        'SAPI is not in "full" mode: mode=%s', mode)));
                } else {
                    next();
                }
            });
        },

        function getSdcApp(ctx, next) {
            ctx.app = self.sdcadm.sdc;
            ctx.sdcadm = self.sdcadm;
            ctx.log = self.log;
            ctx.progress = self.progress;
            next();
        },

        /**
         * SDC Docker usage means biting the bullet and switching to the
         * "new" agents (cn-agent, vm-agent, net-agent) via the "no_rabbit"
         */
        steps.noRabbitEnable,

        function getDockerSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'docker',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.dockerSvc = svcs[0];
                }
                next();
            });
        },

        function getCloudapiSvc(ctx, next) {
            self.sdcadm.sapi.listServices({
                name: 'cloudapi',
                application_uuid: ctx.app.uuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    return next(svcErr);
                } else if (svcs.length) {
                    ctx.cloudapiSvc = svcs[0];
                }
                next();
            });
        },

        /*
         * @field ctx.dockerInst
         * @field ctx.dockerVm
         */
        function getDockerInst(ctx, next) {
            if (!ctx.dockerSvc) {
                return next();
            }
            var filter = {
                service_uuid: ctx.dockerSvc.uuid
            };
            self.sdcadm.sapi.listInstances(filter, function (err, insts) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.dockerInst = insts[0];
                    self.sdcadm.vmapi.getVm({uuid: ctx.dockerInst.uuid},
                            function (vmErr, dockerVm) {
                        if (vmErr) {
                            return next(vmErr);
                        }
                        ctx.dockerVm = dockerVm;
                        next();
                    });
                } else {
                    next();
                }
            });
        },

        function getLatestDockerImage(ctx, next) {
            var filter = {name: 'docker'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.dockerImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError('no "docker" image found'));
                }
            });
        },

        function getLatestDockerloggerImage(ctx, next) {
            var filter = {name: 'dockerlogger'};
            self.sdcadm.updates.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.dockerloggerImg = images[images.length - 1];
                    next();
                } else {
                    next(new errors.UpdateError(
                                'no "dockerlogger" image found'));
                }
            });
        },

        function haveDockerImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.dockerImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.dockerImg);
                } else if (err) {
                    return next(err);
                }
                next();
            });
        },

        function haveDockerloggerImageAlready(ctx, next) {
            self.sdcadm.imgapi.getImage(ctx.dockerloggerImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.dockerloggerImg);
                } else if (err) {
                    return next(err);
                }
                next();
            });
        },

        function importImages(ctx, next) {
            if (ctx.imgsToDownload.length === 0) {
                return next();
            }
            var proc = new DownloadImages({images: ctx.imgsToDownload});
            proc.execute({
                sdcadm: self.sdcadm,
                log: self.log,
                progress: self.progress
            }, next);
        },

        /* @field ctx.userString */
        shared.getUserScript,

        function createDockerSvc(ctx, next) {
            if (ctx.dockerSvc) {
                return next();
            }

            var domain = ctx.app.metadata.datacenter_name + '.' +
                    ctx.app.metadata.dns_domain;
            var svcDomain = dockerSvcData.name + '.' + domain;

            self.progress('Creating "docker" service');
            dockerSvcData.params.image_uuid = ctx.dockerImg.uuid;
            dockerSvcData.metadata['user-script'] = ctx.userScript;
            dockerSvcData.metadata.SERVICE_DOMAIN = svcDomain;
            dockerSvcData.params.billing_id = ctx.dockerPkg.uuid;
            delete dockerSvcData.params.package_name;

            if (ctx.app.metadata.fabric_cfg) {
                dockerSvcData.metadata.USE_FABRICS = true;
            }

            self.sdcadm.sapi.createService('docker', ctx.app.uuid,
                    dockerSvcData, function (err, svc) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                ctx.dockerSvc = svc;
                self.log.info({svc: svc}, 'created docker svc');
                next();
            });
        },

        function getHeadnode(_, next) {
            self.sdcadm.cnapi.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'cnapi'));
                }
                headnode = servers[0];
                return next();
            });
        },
        function createDockerInst(ctx, next) {
            if (ctx.dockerInst) {
                return next();
            }
            self.progress('Creating "docker" instance');
            var instOpts = {
                params: {
                    alias: 'docker0',
                    delegate_dataset: true,
                    server_uuid: headnode.uuid
                }
            };
            self.sdcadm.sapi.createInstance(ctx.dockerSvc.uuid, instOpts,
                    function (err, inst) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Created VM %s (%s)', inst.uuid,
                    inst.params.alias);
                ctx.newDockerInst = inst;
                next();
            });
        },

        /*
         * If not set, set the 'docker' key in CLOUDAPI_SERVICES
         * metadata on the cloudapi service. See "SAPI configuration" section
         * in "sdc-cloudapi.git:blob/master/docs/admin.restdown".
         */
        function updateCloudapiServicesMetadata(ctx, next) {
            var services;

            // Skip, if CLOUDAPI_SERVICES is already set.
            var existing = ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES;
            if (existing) {
                try {
                    services = JSON.parse(existing);
                } catch (ex) {
                    return next(new errors.InternalError({
                        message: format('unexpected non-JSON value for ' +
                            'cloudapi SAPI service "CLOUDAPI_SERVICES" ' +
                            'metadata: %j', existing)
                    }));
                }
                if (services.docker) {
                    return next();
                }
            }

            var dockerInst = ctx.newDockerInst || ctx.dockerInst;
            self.sdcadm.vmapi.getVm({uuid: dockerInst.uuid},
                    function (vmErr, dockerVm) {
                if (vmErr) {
                    return next(vmErr);
                }
                var dockerIp = dockerVm.nics.filter(function (nic) {
                    return nic.nic_tag === 'external';
                })[0].ip;
                var dockerUrl = format('tcp://%s:2376', dockerIp);

                try {
                    services = JSON.parse(
                        ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES || '{}');
                } catch (ex) {
                    return next(new errors.InternalError({
                        message: format('unexpected non-JSON value for ' +
                            'cloudapi SAPI service "CLOUDAPI_SERVICES" ' +
                            'metadata: %j',
                            ctx.cloudapiSvc.metadata.CLOUDAPI_SERVICES)
                    }));
                }
                self.progress('Update "docker" key in CLOUDAPI_SERVICES to',
                    dockerUrl);
                if (!services) {
                    services = {};
                }
                services.docker = dockerUrl;
                var update = {
                    metadata: {
                        CLOUDAPI_SERVICES: JSON.stringify(services)
                    }
                };
                self.sdcadm.sapi.updateService(ctx.cloudapiSvc.uuid, update,
                    errors.sdcClientErrWrap(next, 'sapi'));
            });
        },

        function updateDockerSvcImageUuid(ctx, next) {
            if (!ctx.force &&
                ctx.dockerImg.uuid === ctx.dockerSvc.params.image_uuid) {
                return next();
            }
            self.progress('Update "image_uuid=%s" in "docker" SAPI service',
                ctx.dockerImg.uuid);
            var update = {
                params: {
                    image_uuid: ctx.dockerImg.uuid
                }
            };
            self.sdcadm.sapi.updateService(ctx.dockerSvc.uuid, update,
                errors.sdcClientErrWrap(next, 'sapi'));
        },

        function ensureDockerDelegateDataset(ctx, next) {
            if (ctx.newDockerInst) {
                return next();
            }

            shared.ensureDelegateDataset({
                service: dockerSvcData,
                progress: self.progress,
                zonename: ctx.dockerInst.uuid,
                log: self.log,
                server: ctx.dockerVm.server_uuid
            }, next);
        },

        function reprovisionDockerInst(ctx, next) {
            if (ctx.newDockerInst) {
                return next();
            } else if (!opts.force &&
                ctx.dockerVm.image_uuid === ctx.dockerImg.uuid) {
                return next();
            }
            self.progress('Reprovisioning "docker" instance %s (%s)',
                ctx.dockerVm.uuid, ctx.dockerVm.alias);
            self.sdcadm.sapi.reprovisionInstance(ctx.dockerInst.uuid,
                    ctx.dockerImg.uuid, function (err) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }
                self.progress('Reprovisioned "docker" instance %s (%s)',
                    ctx.dockerVm.uuid, ctx.dockerVm.alias);
                next();
            });
        },

        // From here, pretty much the same thing than for updating dockerlogger
        function getOrCreateDockerloggerSvc(ctx, next) {
            self.progress('Docker setup finished. Installing "dockerlogger"');
            self.sdcadm.sapi.listServices({
                name: 'dockerlogger'
            }, function (err, svcs) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'sapi'));
                }

                if (svcs.length) {
                    ctx.dockerloggerSvc = svcs[0];
                    return next();
                }
                self.progress('Creating "dockerlogger" servivce');
                self.sdcadm.sapi.createService('dockerlogger',
                        self.sdcadm.sdc.uuid, {
                    params: {
                        image_uuid: ctx.dockerloggerImg.uuid
                    },
                    type: 'agent'
                }, function (er2, service) {
                    if (er2) {
                        return next(new errors.SDCClientError(er2, 'sapi'));
                    }
                    ctx.dockerloggerSvc = service;
                    return next();
                });
            });
        },

        function listServers(ctx, next) {
            self.progress('Finding servers for dockerlogger setup');
            // Get all servers to validate if unsetup servers are selected.
            self.sdcadm.cnapi.listServers({}, function (err, servers) {
                if (err) {
                    return next(err);
                }
                ctx.allServers = servers;
                ctx.serversToUpdate = ctx.allServers.filter(function (svr) {
                    return svr.setup;
                });
                next();
            });
        },

        function urDiscoveryGetReady(ctx, next) {
            self.sdcadm.getUrConnection(function (err, urconn) {
                ctx.log.debug({
                    err: err
                }, 'ur error');
                if (err) {
                    next(new errors.InternalError({
                        cause: err,
                        message: 'ur failure'
                    }));
                    return;
                }

                ctx.urConnection = urconn;
                next();
            });
        },

        function urDiscovery(ctx, next) {
            self.progress('Checking servers availability');
            ctx.urServersToUpdate = [];
            var onceNext = once(next);

            var disco = ctx.urConnection.discover({
                timeout: 10 * 1000,
                exclude_headnode: false,
                node_list: ctx.serversToUpdate.map(function (n) {
                    return n.uuid;
                })
            });

            disco.on('server', function discoServer(urServer) {
                ctx.log.trace({urServer: urServer}, 'discoServer');
                ctx.urServersToUpdate.push(urServer);
            });

            disco.on('error', function discoError(err) {
                if (err.nodes_missing && err.nodes_missing.length) {
                    ctx.log.debug({nodes_missing: err.nodes_missing},
                        'ur disco nodes missing');
                    self.progress('Could not find %d servers (ur did not ' +
                        'respond to discovery): %s',
                        err.nodes_missing.length,
                        err.nodes_missing.join(', '));
                } else {
                    self.progress('Unexpected ur discovery failure:', err);
                }
                onceNext(err);
            });

            disco.on('duplicate', function discoDup(dupUuid, dupHostname) {
                var err = new errors.InternalError({
                    message: format('Duplicate server found during ur ' +
                        'discovery: uuid=%s dupHostname=%s',
                        dupUuid, dupHostname)
                });
                err.duplicate = [dupUuid, dupHostname];

                /*
                 * We are done with this discovery session.  Cancel it and
                 * ignore future error/end events.
                 */
                disco.cancel();
                onceNext(err);
            });

            disco.on('end', function discoEnd() {
                ctx.log.trace('discoEnd');
                next();
            });
        },

        // TODO: Check file is not already at downloadDir from a previous
        // run (including checksum)
        function getImgFileFromLocalImgapi(ctx, next) {
            ctx.progress('Getting image file from local imgapi');
            ctx.filepath = path.resolve(ctx.downloadDir,
            'dockerlogger-' + ctx.dockerloggerImg.uuid + '.sh');
            self.sdcadm.imgapi.getImageFile(ctx.dockerloggerImg.uuid,
                    ctx.filepath,
                    function (err, res) {
                if (err) {
                    return next(new errors.SDCClientError(err, 'imgapi'));
                }
                next();
            });
        },

        // TODO: Check the file is not already in assetsdir from a
        // previous run, checksum included.
        function copyImgFileToAssets(ctx, next) {
            var assetsdir = '/usbkey/extra/dockerlogger';
            self.progress('Copying dockerlogger to assets dir:', assetsdir);
            var argv = ['cp', ctx.filepath, assetsdir];
            mkdirp.sync(assetsdir);
            common.execFilePlus({
                argv: argv,
                log: ctx.log
            }, function (err, stderr, stdout) {
                ctx.log.trace({
                    cmd: argv.join(' '),
                    err: err,
                    stdout: stdout,
                    stderr: stderr
                }, 'ran cp command');
                if (err) {
                    return next(new errors.InternalError({
                        message: format('error copying shar file to %s',
                                         assetsdir),
                        cmd: argv.join(' '),
                        stdout: stdout,
                        stderr: stderr,
                        cause: err
                    }));
                }
                next();
            });
        },

        function updateLogger(ctx, next) {
            self.progress('Starting dockerlogger update on %d servers',
                ctx.urServersToUpdate.length);
            ctx.fname = path.basename(ctx.filepath);
            var ip = self.sdcadm.config.assets_admin_ip;
            var f = ctx.fname;
            var ff = '/var/tmp/' + f;
            // Do not override log file if we run installer more than once
            // for the same version.
            // TODO(trent): Won't these build up? Should clean these out.
            var lf = '/var/tmp/' + f + '_' + uuid() + '_install.log';


            var downloadCmd = [
                'cd /var/tmp;',
                '',
                /*
                 * Exit 22 if cannot download the installer file (curl code)
                 */
                '/usr/bin/curl -kOsf ' + ip + ':/extra/dockerlogger/' + f,
                'if [[ "$?" -ne "0" ]]; then',
                '   exit $?',
                'fi',
                ''
            ].join('\n');

            var installCmd = [
                'cd /var/tmp;',
                '',
                /*
                 * Exit 30 if installer fails
                 */
                '/usr/bin/bash ' + ff + ' </dev/null >' + lf + ' 2>&1',
                'if [[ "$?" -ne "0" ]]; then',
                '   exit 30',
                'fi',
                ''
            ].join('\n');

            vasync.forEachPipeline({
                inputs: [
                    {
                        str: downloadCmd,
                        progbarName: 'Downloading dockerlogger',
                        timeout: 10 * 60 * 1000
                    },
                    {
                        str: installCmd,
                        progbarName: 'Installing dockerlogger',
                        timeout: 20 * 60 * 1000
                    }
                ],
                func: function runUrQueue(cmd, nextCmd) {
                    assert.object(ctx.urConnection, 'ctx.urConnection');
                    var queueOpts = {
                        sdcadm: self.sdcadm,
                        urConnection: ctx.urConnection,
                        log: ctx.log,
                        progress: self.progress,
                        command: cmd.str,
                        concurrency: opts.concurrency,
                        timeout: cmd.timeout
                    };

                    var bar;
                    if (process.stderr.isTTY) {
                        bar = new ProgressBar({
                            size: ctx.urServersToUpdate.length,
                            bytes: false,
                            filename: cmd.progbarName
                        });
                        queueOpts.progbar = bar;
                        bar.advance(0); // Draw initial progbar at 0.
                    }
                    ctx.log.trace({
                        command: cmd.str,
                        concurrency: opts.concurrency
                    }, 'runUrQueue');

                    var rq = ur.runQueue(queueOpts,
                            function runQueueCb(err, results) {
                        if (err) {
                            return nextCmd(new errors.UpdateError(
                                err, 'unexpected runQueue error'));
                        }

                        var errs = [];
                        results.forEach(function (r) {
                            if (r.error || r.result.exit_status !== 0) {
                                errs.push(new errors.UpdateError(format(
                                    '%s failed on server %s (%s): %j',
                                    cmd.progbarName, r.uuid, r.hostname,
                                    r.error || r.result)));
                            }
                        });
                        if (errs.length === 1) {
                            nextCmd(errs[0]);
                        } else if (errs.length > 1) {
                            nextCmd(new errors.MultiError(errs));
                        } else {
                            nextCmd();
                        }
                    });

                    rq.on('success', function onSuccess(server, result) {
                        // A non-zero exit from the command is a "success".
                        if (result.exit_status !== 0) {
                            var errmsg = format(
                                '%s failed on server %s (%s): %j',
                                cmd.progbarName, server.uuid,
                                server.hostname, result);
                            if (cmd.logFile) {
                                errmsg += ' (log file on server: ' +
                                    cmd.logFile + ')';
                            }
                            if (bar) {
                                bar.log(errmsg);
                            } else {
                                console.log(errmsg);
                            }
                        }
                    });

                    rq.start();
                    ctx.urServersToUpdate.forEach(function (us) {
                        rq.add_server(us);
                    });
                    rq.close();
                }
            }, function doneCmds(err, _) {
                next(err);
            });
        },

        function doCleanup(ctx, next) {
            self.progress('Deleting temporary %s', ctx.filepath);
            fs.unlink(ctx.filepath, function (err) {
                if (err) {
                    ctx.log.warn(err, 'could not unlink %s', ctx.filepath);
                }
                next();
            });
        },

        function updateSvcImage(ctx, next) {
            self.progress('Updating "dockerlogger" service in SAPI');
            self.sdcadm.sapi.updateService(ctx.dockerloggerSvc.uuid, {
                params: {
                    image_uuid: ctx.dockerloggerImg.uuid
                }
            }, next);
        },


        function done(_, next) {
            self.progress('Updated SDC Docker (%ds)',
                Math.floor((Date.now() - start) / 1000));
            next();
        }
    ]}, cb);
}

do_docker.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['force', 'f'],
        type: 'bool',
        help: 'Allow update to proceed even if already at latest image.'
    }
];
do_docker.help = (
    'Create the docker service and the docker instance on the headnode.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} docker\n' +
    '\n' +
    '{{options}}' +
    '\n'
);

// --- exports

module.exports = {
    do_docker: do_docker
};
