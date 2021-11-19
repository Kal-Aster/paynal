#!/usr/bin/env node

require = require("esm")(module);

const fs = require("fs");
const path = require("path");

const { Client: SSHClient } = require("ssh2");

const configFileName = "./paynal.config";
const deployInfo = ".paynal-info";

function statToAttrs(stats) {
    var attrs = {};
    for (var attr in stats) {
        if (!stats.hasOwnProperty(attr)) {
            continue;
        }
        attrs[attr] = stats[attr];
    }
    return attrs;
}

class Client {
    constructor(config) {
        this.config = config;
    }

    _concurrentActiveConnections = 0
    _session = null
    _sftp = null

    _callWhenAvailable(func) {
        const maxConcurrentConnection = 1; // typeof this.config.maxConnections === "number" && this.config.maxConnections >= 1 ? this.config.maxConnections : 1;
        if (this._concurrentActiveConnections < maxConcurrentConnection) {
            this._concurrentActiveConnections++;
            return this._connect()
            .then(session => {
                return this._multipleTryPromise(() => func(session))
            })
            .then(result => {
                this._concurrentActiveConnections--;
                return result;
            })
            .catch(err => {
                this._concurrentActiveConnections--;
                throw err;
            });
        }
        return new Promise(resolve => {
            setTimeout(resolve, 50);
        }).then(() => this._callWhenAvailable(func));
    }
    _closeFTP() {
        return this._sftp ? this._sftp.then(sftp => {
            this._sftp = null;
            sftp.end();
            return true;
        }) : Promise.resolve(true);
    }
    _connect() {
        return this._session || (this._session = this._multipleTryPromise(() => {
            return new Promise((resolve, reject) => {
                var conn = new SSHClient()
                conn.on('ready', function () {
                    conn.removeAllListeners();
                    resolve(conn);
                })
                .on('end', function () {
                    reject(new Error('Connection closed'));
                })
                .on('error', function (err) {
                    reject(err);
                });
                try {
                    conn.connect(this.config);
                } catch (err) {
                    reject(err);
                }
            });
        }).catch(err => {
            this._session = null;
            throw err;
        }));
    }
    _connectSFTP() {
        return this._sftp || (this._sftp = new Promise((resolve, reject) => {
            this._connect().then(session => {
                session.sftp(function(err, sftp) {
                    if (err) {
                        this._sftp = null;
                        return reject(err);
                    }
                    resolve(sftp);
                })
            })
        }));
    }
    _multipleTryPromise(func) {
        const maxRetry = typeof this.config.maxRetry === "number" && this.config.maxRetry >= 0 ? this.config.maxRetry : 25;
        return (function multipleTryPromise(currentTry = 1) {
            return func()
            .catch(err => {
                if (err.message.match(/timed out.*handshake/i) && currentTry < maxRetry) {
                    return multipleTryPromise(func, currentTry + 1);
                }
                throw err;
            });
        }());
    }

    end() {
        return (this._closeFTP())
        .then(() => this._session || Promise.resolve(null))
        .then(session =>  {
            if (session) {
                this._session = null;
                session.end();
            }
            return true;
        });
    }
    exec(cmd, mirrorOutput = false) {
        return this._callWhenAvailable(() => {
            return this.end().then(() => this._connect())
            .then((session) => new Promise((resolve, reject) => {
                session.exec(cmd, (err, stream) => {
                    if (err) {
                        return reject(err);
                    }
                    let stdout = "";
                    let stderr = "";
                    stream.on('close', (code, signal) => {
                        const result = { code, signal, stdout, stderr };
                        if (code !== 0) {
                            const error = new Error(stderr);
                            error.result = result;
                            return reject(error);
                        }
                        resolve(result)
                    }).on('data', (data) => {
                        stdout += data;
                        if (mirrorOutput) {
                            console.log("" + data);
                        }
                    }).stderr.on('data', (data) => {
                        stderr += data;
                        if (mirrorOutput) {
                            console.error("" + data);
                        }
                    });
                });
            }));
        });
    }
    mkdir(path) {
        return this._callWhenAvailable((session) => {
            return this._connectSFTP().then(sftp => {
                return new Promise((resolve, reject) => {
                    sftp.mkdir(path, function (err) {
                        if (err) {
                            return reject(err);
                        }
                        return resolve(true);
                    });
                });
            });
        });
    }
    put(local, remote) {
        return this._callWhenAvailable((session) => {
            return this._connectSFTP().then(sftp => {
                return new Promise((resolve, reject) => {
                    sftp.fastPut(local, remote, (err) => {
                        if (err) {
                            return reject(err);
                        }
                        resolve(true);
                    });
                });
            });
        });
    }
    stat(location) {
        return this._callWhenAvailable((session) => {
            return this._connectSFTP().then(sftp => {
                return new Promise((resolve, reject) => {
                    sftp.stat(location, function (err, stat) {
                        if (err) {
                            return reject(err);
                        }
                        var attrs = statToAttrs(stat);
                        attrs.path = location;
                        if (stat.isDirectory()) {
                            attrs.type = "directory";
                        } else if (stat.isFile()) {
                            attrs.type = "file";
                        } else {
                            attrs.type = "other";
                        }
                        resolve(attrs);
                    })
                });
            });
        });
    }
}

(async function () {
    const config = normalizeConfig(require(configFileName).default);
    const dsts = Object.keys(config.dst);
    if (dsts.length === 0) {
        console.log("No destinations defined");
        return;
    }

    if (
        !config.connection.host ||
        !config.connection.username ||
        !config.connection.password
    ) {
        console.log("Invalid connection configuration");
        return;
    }

    const localPaths = (
        Array.isArray(config.src) ? config.src : [config.src]
    ).filter(path => (typeof path === "string" || path instanceof String) && !!path);

    if (localPaths.length === 0) {
        console.log("No source to deploy");
        return;
    }
    
    const remotEnvName = process.argv[2] || dsts[0];
    const remotEnvs = [];
    try {
        remotEnvs.push(getEnv(remotEnvName, config));
        prependRequired(remotEnvs, config);
    } catch (e) {
        console.log(e.message);
        return;
    }

    const connection = new Client(config.connection);

    for (let i = 0; i < remotEnvs.length; i++) {
        const remotEnv = remotEnvs[i];

        const envPaths = localPaths.concat(remotEnv.add).filter(path => !remotEnv.skip.includes(path));

        console.log(`Deploying "${remotEnv.name}"`);

        if (!(await runHook(config, "pre", [remotEnv, connection]))) {
            return process.exit();
        }
    
        const lastDeployedMTimeMs = getLastDeployedMTimeMs(remotEnv.name);
    
        const sendingResult = { sent: 0, loading: 0, folders: 0 };
        await Promise.all(envPaths.map(dir => {
            return sendPathTo(
                connection, lastDeployedMTimeMs,
                dir, remotEnv.path,
                sendingResult
            );
        }));
        process.stdout.write("\n");
        saveLastDeployedMTimeMs(remotEnv.name);
        
        if (!(await runHook(config, "post", [remotEnv, connection]))) {
            return process.exit();
        }
        console.log(`Deployed "${remotEnv.name}"`);
    }

    await connection.end();

    await runHook(config, "done");
    process.exit();
    // console.log(
    //     process._getActiveHandles(),
    //     process._getActiveRequests()
    // );
}());

function normalizeConfig(config) {
    const connection = config.connection ? {
        ...config.connection,
        host: typeof config.connection.host === "string" ? config.connection.host || undefined : undefined,
        username: typeof config.connection.username === "string" ? config.connection.username || undefined : undefined,
        password: typeof config.connection.password === "string" ? config.connection.password || undefined : undefined
    } : {};
    return {
        connection,
        src: config.src,
        dst: config.dst || {},
        plugins: config.plugins || []
    };
}

function normalizeEnv(name, env) {
    if (!env) {
        return null;
    }
    if (typeof env === "string" || env instanceof String) {
        return Object.freeze({
            name,
            path: env,
            requires: []
        });
    }
    if (typeof env !== "object" || !(typeof env.path === "string" || env.path instanceof String)) {
        return null;
    }
    return Object.freeze({
        name,
        path: env.path,
        add: Object.freeze((
            Array.isArray(env.add) ? env.add : [env.add]
        ).filter(added => (typeof added === "string" || added instanceof String) && !!added)),
        skip: Object.freeze((
            Array.isArray(env.skip) ? env.skip : [env.skip]
        ).filter(skipped => (typeof skipped === "string" || skipped instanceof String) && !!skipped)),
        requires: Object.freeze((
            Array.isArray(env.requires) ? env.requires : [env.requires]
        ).filter(required => (typeof required === "string" || required instanceof String) && !!required && required !== name))
    })
}

function logSendingResult(sendingResult) {
    process.stdout.write(`Sent ${sendingResult.sent} of ${sendingResult.loading} (${sendingResult.folders} folders)   \r`);
}

function sendPathTo(connection, lastDeployedMTimeMs, localPath, remotePath, sendingResult) {
    if (!fs.existsSync(localPath)) {
        return;
    }
    const stat = fs.lstatSync(localPath);
    if (stat.mtimeMs <= lastDeployedMTimeMs) {
        sendingResult.loading++;
        sendingResult.sent++;
        return;
    }
    const localname = path.basename(localPath);
    const remoteDir = path.join(remotePath, localname).replace(/[\\\/]+/g, "/");
    if (stat.isDirectory()) {
        const files = fs.readdirSync(localPath);
        sendingResult.folders++;
        return connection.stat(remoteDir).then(() => {}, () => {
            return connection.mkdir(remoteDir)
            .then(() => {
                console.log(`Created "${remoteDir}" folder`);
            })
            .catch(err => {
                console.log(`Error creating "${remoteDir}" folder"`);
                throw err;
            });
        })
        .then(() => {
            sendingResult.folders--;
        })
        .then(() => Promise.all(files.map(file => {
            const localFile = path.join(localPath, file).replace(/[\\\/]+/g, "/");
            const remoteFile = path.join(remoteDir, file).replace(/[\\\/]+/g, "/");
            return sendPathTo(connection, lastDeployedMTimeMs, localFile, remoteDir, sendingResult);
        })));
    }
    sendingResult.loading++;
    logSendingResult(sendingResult);

    return connection.stat(remoteDir)
    .then((remoteStat) => {
        return remoteStat.mtime < (stat.mtimeMs / 1000);
    })
    .catch(() => true)
    .then(shouldPut => {
        if (!shouldPut) {
            sendingResult.sent++;
            logSendingResult(sendingResult);
            return;
        }
        return connection.put(localPath, remoteDir)
        .then(result => {
            if (!result) {
                throw new Error(`Error sending "${localPath}"`);
            }
            sendingResult.sent++;
            logSendingResult(sendingResult);
        })
        .catch((err) => {
            console.log(`Error sending "${localPath}" to "${remotePath}"`);
            throw err;
        });
    });
}

function getLastDeployedMTimeMs(env) {
    if (!fs.existsSync(deployInfo)) {
        return 0;
    }
    const deployData = JSON.parse(fs.readFileSync(deployInfo));
    const envData = deployData[env];
    if (!envData) {
        return 0;
    }
    const lastConfigMTimeMs = fs.statSync("deploy.config.js").mtimeMs;
    if (envData.lastConfigMTimeMs !== lastConfigMTimeMs) {
        return 0;
    }
    return envData.deployed;
}

function saveLastDeployedMTimeMs(env) {
    const deployData = fs.existsSync(deployInfo) ? JSON.parse(fs.readFileSync(deployInfo)) : {};
    const envData = deployData[env] || (deployData[env] = {});
    envData.lastConfigMTimeMs = fs.statSync("deploy.config.js").mtimeMs;
    envData.deployed = Date.now();
    fs.writeFileSync(deployInfo, JSON.stringify(deployData));
}

function getEnv(envName, config) {
    const env = normalizeEnv(envName, config.dst[envName]);
    if (env === null) {
        throw new Error(`Invalid or inexistent env named: "${envName}"`);
    }
    return env;
}

function prependRequired(envs, config) {
    for (let i = envs.length - 1; i >= 0; i--) {
        const env = envs[i];
        const required = env.requires.map(required => getEnv(required, config));
        i += required.length;
        envs.unshift(...required);
    }
    for (let i = 0; i < envs.length; i++) {
        const env = envs[i];
        if (envs.findIndex((candidate) => {
            return candidate.name === env.name;
        }) === i) {
            continue;
        }
        envs.splice(i, 1);
        i--;
    }
}

async function runHook(config, event, args) {
    for (let i = 0; i < config.plugins.length; i++) {
        const plugin = config.plugins[i];

        if (!plugin[event]) {
            continue;
        }
        console.log(`Running "${plugin.name}" ${event}-hook`);
        try {
            await plugin[event].apply(null, args);
        } catch (e) {
            if (event !== "error") {
                runHook(config, "error", [e]);
            }
            return false;
        }
    }
    return true;
}
