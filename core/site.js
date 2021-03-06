"use strict";

const yaml    = require("js-yaml");
const fs      = require("fs");
const _       = require("underscore");
const {spawn} = require("child_process");

class Site {
    constructor(siteName, dvr, tui) {
        this.siteName   = siteName;
        this.dvr        = dvr;
        this.tui        = tui;
        this.padName    = siteName.padEnd(9, " ");
        this.listName   = siteName.toLowerCase();
        this.cfgName    = dvr.configdir + this.listName + ".yml";
        this.updateName = dvr.configdir + this.listName + "_updates.yml";
        this.colors     = dvr.colors;

        // <plugin>.yml
        this.siteConfig = yaml.safeLoad(fs.readFileSync(this.cfgName, "utf8"));

        this.siteDir = "_" + this.listName; // Directory suffix
        this.tempList = [];                 // temp record list (session only)
        this.streamerList = new Map();      // Refer to addStreamer() for JSON entries
        this.streamerListDamaged = false;

        if (dvr.config.tui.enable) {
            tui.addSite(this);
        }

        this.infoMsg(this.siteConfig.streamers.length + " streamer(s) in config");

        if (typeof this.siteConfig.siteUrl === "undefined") {
            this.errMsg(this.cfgName + " is missing siteUrl");
        }
    }

    getStreamerList() {
        return Array.from(this.streamerList.values());
    }

    getFileName(nm) {
        const site = this.dvr.config.recording.includeSiteInFile ? this.listName + "_" : "";
        return nm + "_" + site + this.dvr.getDateTime();
    }

    checkFileSize() {
        const maxSize = this.dvr.config.recording.maxSize;
        for (const streamer of this.streamerList.values()) {
            if (streamer.captureProcess === null || streamer.postProcess) {
                continue;
            }

            const stat = fs.statSync(this.dvr.config.recording.captureDirectory + "/" + streamer.filename);
            const sizeMB = Math.round(stat.size / 1048576);
            this.dbgMsg(this.colors.file(streamer.filename) + ", size=" + sizeMB + "MB, maxSize=" + maxSize + "MB");
            if (sizeMB === streamer.filesize) {
                this.infoMsg(this.colors.name(streamer.nm) + " recording appears to be stuck (counter=" + streamer.stuckcounter + "), file size is not increasing: " + sizeMB + "MB");
                streamer.stuckcounter++;
            } else {
                streamer.filesize = sizeMB;
            }
            if (streamer.stuckcounter >= 2) {
                this.infoMsg(this.colors.name(streamer.nm) + " terminating stuck recording");
                this.haltCapture(streamer.uid);
                streamer.stuckcounter = 0;
                this.streamerListDamaged = true;
            } else if (maxSize !== 0 && sizeMB >= maxSize) {
                this.infoMsg(this.colors.name(streamer.nm) + " recording has exceeded file size limit (size=" + sizeMB + " > maxSize=" + maxSize + ")");
                this.haltCapture(streamer.uid);
                this.streamerListDamaged = true;
            }
        }
    }

    connect() {
        // optional virtual method
    }

    disconnect() {
        // optional virtual method
    }

    getCaptureArguments(url, filename, options) {
        let args = [
            this.dvr.config.recording.captureDirectory + "/" + filename + ".ts",
            url,
            this.dvr.config.proxy.enable ? "1" : "0",
            this.dvr.config.proxy.server,
            this.dvr.config.debug.recorder ? "1" : "0",
            this.siteConfig.username ? "1" : "0",
            this.siteConfig.username ? "--" + this.listName + "-username=" + this.siteConfig.username : "",
            this.siteConfig.password ? "--" + this.listName + "-password=" + this.siteConfig.password : ""
        ];

        if (options && options.params) {
            args = args.concat(options.params);
        }

        return args;
    }

    async processUpdates(options) {
        const stats = fs.statSync(this.updateName);
        if (!stats.isFile()) {
            this.dbgMsg(this.updateName + " does not exist");
            return;
        }

        const updates = yaml.safeLoad(fs.readFileSync(this.updateName, "utf8"));
        let list = [];

        if (options.add) {
            if (!updates.include) {
                updates.include = [];
            } else if (updates.include.length > 0) {
                this.infoMsg(updates.include.length + " streamer(s) to include");
                list = updates.include;
                updates.include = [];
            }
        } else if (!updates.exclude) {
            updates.exclude = [];
        } else if (updates.exclude.length > 0) {
            this.infoMsg(updates.exclude.length + " streamer(s) to exclude");
            list = updates.exclude;
            updates.exclude = [];
        }

        // clear the processed array from file
        if (list.length > 0) {
            fs.writeFileSync(this.updateName, yaml.safeDump(updates), "utf8");
        }

        try {
            const dirty = await this.updateStreamers(list, options);
            if (dirty) {
                await this.writeConfig();
            }
        } catch (err) {
            this.errMsg(err.toString());
        }
    }

    updateList(id, options) {
        let dirty = false;
        let list = options.isTemp ? this.tempList : this.siteConfig.streamers;
        if (options.pause > 0) {
            if (this.streamerList.has(id.uid)) {
                const streamer = this.streamerList.get(id.uid);
                if (options.pause === 1) {
                    this.infoMsg(this.colors.name(id.nm) + " is paused.");
                    streamer.paused = true;
                    this.haltCapture(id.uid);
                } else if (options.pause === 2) {
                    this.infoMsg(this.colors.name(id.nm) + " is unpaused.");
                    streamer.paused = false;
                    this.refresh(streamer, options);
                }
                this.render(true);
            }
            return false;
        } else if (options.add) {
            if (this.addStreamer(id, list, options)) {
                list.push(id.uid);
                dirty = true;
            }
        } else if (this.removeStreamer(id, list)) {
            if (this.siteConfig.streamers.indexOf(id.uid) !== -1) {
                list = _.without(list, id.uid);
                dirty = true;
            }
        }
        if (dirty) {
            if (options.isTemp) {
                this.tempList = list;
            } else {
                this.siteConfig.streamers = list;
            }
        }
        return dirty && !options.isTemp;
    }

    pause(state) {
        for (const streamer of this.streamerList.values) {
            streamer.paused = state;
            if (state) {
                this.haltCapture(streamer.uid);
            } else if (streamer.state !== "Offline") {
                this.refresh(streamer);
            }
        }
        this.render(true);
    }

    updateStreamers(list, options) {
        let dirty = false;

        for (let i = 0; i < list.length; i++) {
            dirty |= this.updateList(list[i], {add: options.add, pause: 0, isTemp: false, init: options.init});
        }

        return dirty;
    }

    addStreamer(id, list, options) {
        let added = false;

        if (list.indexOf(id.uid) === -1) {
            this.infoMsg(this.colors.name(id.nm) + " added to capture list" + (options.isTemp ? " (temporarily)" : ""));
            added = true;
        } else {
            this.errMsg(this.colors.name(id.nm) + " is already in the capture list");
        }

        if (!this.streamerList.has(id.uid)) {
            this.streamerList.set(id.uid, {
                uid: id.uid,
                nm: id.nm,
                site: this.padName,
                state: "Offline",
                filename: "",
                captureProcess: null,
                postProcess: 0,
                filesize: 0,
                stuckcounter: 0,
                isTemp: options.isTemp,
                paused: false
            });
            this.render(true);
            if (!options || !options.init) {
                this.refresh(this.streamerList.get(id.uid), options);
            }
        }
        return added;
    }

    removeStreamer(id) {
        if (this.streamerList.has(id.uid)) {
            this.infoMsg(this.colors.name(id.nm) + " removed from capture list.");
            this.haltCapture(id.uid);
            this.streamerList.delete(id.uid); // Note: deleting before recording/post-processing finishes
            this.render(true);
            return true;
        }
        this.errMsg(this.colors.name(id.nm) + " not in capture list.");
        return false;
    }

    checkStreamerState(streamer, msg, isStreaming, prevState) {
        if (streamer.state !== prevState) {
            this.infoMsg(msg);
            this.streamerListDamaged = true;
        }
        if (streamer.postProcess === 0 && streamer.captureProcess !== null && !isStreaming) {
            // Sometimes the recording process doesn't end when a streamer
            // stops broadcasting, so terminate it.
            this.dbgMsg(this.colors.name(streamer.nm) + " is no longer broadcasting, terminating capture process (pid=" + streamer.captureProcess.pid + ")");
            this.haltCapture(streamer.uid);
        }
        this.render(false);
    }

    getStreamers() {
        if (this.dvr.tryingToExit) {
            this.dbgMsg("Skipping lookup while exit in progress...");
            return false;
        }
        this.checkFileSize();
        return true;
    }

    storeCapInfo(streamer, filename, captureProcess) {
        streamer.filename = filename;
        streamer.captureProcess = captureProcess;
        this.render(true);
    }

    getNumCapsInProgress() {
        let count = 0;

        for (const streamer of this.streamerList.values()) {
            count += streamer.captureProcess !== null;
        }

        return count;
    }

    haltAllCaptures() {
        for (const streamer of this.streamerList.values()) {
            // Don't kill post-process jobs, or recording can get lost.
            if (streamer.captureProcess !== null && streamer.postProcess === 0) {
                streamer.captureProcess.kill("SIGINT");
            }
        }
    }

    haltCapture(uid) {
        if (this.streamerList.has(uid)) {
            const streamer = this.streamerList.get(uid);
            if (streamer.captureProcess !== null && streamer.postProcess === 0) {
                streamer.captureProcess.kill("SIGINT");
            }
        }
    }

    async writeConfig() {
        let filehandle;
        try {
            filehandle = await fs.promises.open(this.cfgName, "w");
            await filehandle.writeFile(yaml.safeDump(this.siteConfig));
        } finally {
            if (filehandle) {
                this.dbgMsg("Rewriting " + this.cfgName);
                await filehandle.close();
            } else {
                this.errMsg("Could not write " + this.cfgName);
            }
        }
    }

    setupCapture(uid) {
        if (this.streamerList.has(uid)) {
            const streamer = this.streamerList.get(uid);
            if (streamer.captureProcess !== null) {
                this.dbgMsg(this.colors.name(streamer.nm) + " is already capturing");
                return false;
            }
            return true;
        }
        return false;
    }

    async getCompleteDir(streamer) {
        let completeDir = this.dvr.config.recording.completeDirectory;

        if (this.dvr.config.recording.siteSubdir) {
            completeDir += "/" + this.siteName;
        }
        if (this.dvr.config.recording.streamerSubdir) {
            completeDir += "/" + streamer.nm;
            if (this.dvr.config.recording.includeSiteInDir) {
                completeDir += this.siteDir;
            }
            try {
                await fs.promises.mkdir(completeDir, {recursive: true});
            } catch (err) {
                this.errMsg(err.toString());
            }
        }

        return completeDir;
    }

    async refresh(streamer, options) {
        if (!this.dvr.tryingToExit && this.streamerList.has(streamer.uid)) {
            if (!options || !options.init) {
                await this.checkStreamerState(streamer.uid);
            }
        }
    }

    startCapture(capInfo) {
        if (capInfo.spawnArgs === "") {
            return;
        }

        const streamer = capInfo.streamer;
        const fullname = capInfo.filename + ".ts";
        const script   = this.dvr.calcPath(this.siteConfig.recorder);

        let cmd = script + " ";
        for (const arg of capInfo.spawnArgs.values()) {
            cmd += arg + " ";
        }
        this.dbgMsg("Starting recording: " + this.colors.cmd(cmd));

        const captureProcess = spawn(script, capInfo.spawnArgs);

        if (this.dvr.config.debug.recorder) {
            const logStream = fs.createWriteStream("./" + capInfo.filename + ".log", {flags: "w"});
            captureProcess.stdout.pipe(logStream);
            captureProcess.stderr.pipe(logStream);
        }

        if (captureProcess.pid) {
            this.infoMsg(this.colors.name(streamer.nm) + " recording started: " + this.colors.file(capInfo.filename + ".ts"));
            this.storeCapInfo(streamer, fullname, captureProcess);
        }

        captureProcess.on("close", () => {

            fs.stat(this.dvr.config.recording.captureDirectory + "/" + fullname, (err, stats) => {
                if (err) {
                    if (err.code === "ENOENT") {
                        this.errMsg(this.colors.name(streamer.nm) + ", " + this.colors.file(capInfo.filename) + ".ts not found in capturing directory, cannot convert to " + this.dvr.config.recording.autoConvertType);
                    } else {
                        this.errMsg(this.colors.name(streamer.nm) + ": " + err.toString());
                    }
                    this.storeCapInfo(streamer, "", null);
                } else {
                    const sizeMB = stats.size / 1048576;
                    if (sizeMB < this.dvr.config.recording.minSize) {
                        this.infoMsg(this.colors.name(streamer.nm) + " recording automatically deleted (size=" + sizeMB + " < minSize=" + this.dvr.config.recording.minSize + ")");
                        fs.unlinkSync(this.dvr.config.recording.captureDirectory + "/" + fullname);
                        this.storeCapInfo(streamer, "", null);
                    } else {
                        this.dvr.postProcessQ.push({site: this, streamer: streamer, filename: capInfo.filename});
                        if (this.dvr.postProcessQ.length === 1) {
                            this.dvr.postProcess();
                        }
                    }
                }
            });

            this.refresh(streamer);
        });
    }

    setProcessing(streamer) {
        // Need to remember post-processing is happening, so that
        // the offline check does not kill postprocess jobs.
        streamer.postProcess = 1;
        this.streamerListDamaged = true;
    }

    clearProcessing(streamer) {
        // Note: setting postProcess to null releases program to exit
        this.storeCapInfo(streamer, "", null);
        this.streamerListDamaged = true;

        streamer.postProcess = 0;
        this.refresh(streamer);
    }

    render(listDamaged) {
        if (this.dvr.config.tui.enable) {
            this.tui.render(listDamaged || this.streamerListDamaged, this);
        }
    }

    msg(msg, options) {
        this.dvr.log(this.colors.time("[" + this.dvr.getDateTime() + "] ") + this.colors.site(this.padName) + msg, options);
    }

    infoMsg(msg) {
        this.msg("[INFO]  " + msg);
    }

    errMsg(msg) {
        this.msg(this.colors.error("[ERROR] ") + msg, {trace: true});
    }

    dbgMsg(msg) {
        if (this.dvr.config.debug.log) {
            this.msg(this.colors.debug("[DEBUG] ") + msg);
        }
    }
}

exports.Site = Site;

