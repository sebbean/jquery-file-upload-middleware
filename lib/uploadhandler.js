var EventEmitter = require('events').EventEmitter,
    path = require('path'),
    fs = require('fs'),
    formidable = require('formidable'),
    imageMagick = require('imagemagick'),
    mkdirp = require('mkdirp'),
    _ = require('lodash'),
    ffmpeg = require('fluent-ffmpeg')

module.exports = function (options) {

    var FileInfo = require('./fileinfo')(
        _.extend({
            baseDir: options.uploadDir
        }, _.pick(options, 'minFileSize', 'maxFileSize', 'acceptFileTypes'))
    );

    var UploadHandler = function (req, res, callback) {
        EventEmitter.call(this);
        this.req = req;
        this.res = res;
        this.callback = callback;
    };
    require('util').inherits(UploadHandler, EventEmitter);

    UploadHandler.prototype.noCache = function () {
        this.res.set({
            'Pragma': 'no-cache',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Content-Disposition': 'inline; filename="files.json"'
        });
    };

    UploadHandler.prototype.get = function () {
        this.noCache();
        var files = [];
        fs.readdir(options.uploadDir(), _.bind(function (err, list) {
            _.each(list, function (name) {
                var stats = fs.statSync(options.uploadDir() + '/' + name),
                    fileInfo;
                if (stats.isFile()) {
                    fileInfo = new FileInfo({
                        name: name,
                        size: stats.size
                    });
                    this.initUrls(fileInfo);
                    files.push(fileInfo);
                }
            }, this);
            this.callback(files);
        }, this));
    };

    UploadHandler.prototype.post = function () {

        var self = this,
            form = new formidable.IncomingForm(),
            tmpFiles = [],
            files = [],
            map = {},
            counter = 1,
            redirect,
            finish = _.bind(function () {
                if (!--counter) {
                    _.each(files, function (fileInfo) {
                        this.initUrls(fileInfo);
                        this.emit('end', fileInfo);
                    }, this);
                    this.callback(files, redirect);
                }
            }, this);

        this.noCache();

        form.uploadDir = options.tmpDir;
        form
            .on('fileBegin', function (name, file) {
                tmpFiles.push(file.path);
                var fileInfo = new FileInfo(file);
                fileInfo.safeName();
                map[path.basename(file.path)] = fileInfo;
                files.push(fileInfo);
                self.emit('begin', fileInfo);
            })
            .on('field', function (name, value) {
                if (name === 'redirect') {
                    redirect = value;
                }
            })
            .on('file', function (name, file) {
                var fileInfo = map[path.basename(file.path)];
                if (fs.existsSync(file.path)) {
                    fileInfo.size = file.size;
                    if (!fileInfo.validate()) {
                        fs.unlink(file.path);
                        return;
                    }

                    var generatePreviews = function () {

                        if (options.videoTypes.test(fileInfo.name)) {
                            var image_path = options.uploadDir() + '/' + path.basename(file.path) + '.png';
                            console.log(image_path)
                            break;
                            var proc = new ffmpeg({
                                // input source, required
                                source: options.uploadDir() + '/' + fileInfo.name,
                                // timout of the spawned ffmpeg sub-processes in seconds (optional, defaults to 30)
                                timeout: 30,
                                // default priority for all ffmpeg sub-processes (optional, defaults to 0 which is no priorization)
                                priority: 0,
                                // set a custom [winston](https://github.com/flatiron/winston) logging instance (optional, default null which will cause fluent-ffmpeg to spawn a winston console logger)
                                logger: null,
                                // completely disable logging (optional, defaults to false)
                                nolog: false
                            })  
                            // .withSize('450x?')
                            .addOption('-vframes', '1')
                            .onProgress(function(progress) {
                                // console.log(progress);
                            })  
                            .saveToFile(image_path, function(retcode, error) {
                                console.log('file has been converted succesfully');
                                _.each(options.imageVersions, function (value, version) {
                                    // creating directory recursive
                                    if (!fs.existsSync(options.uploadDir() + '/' + version + '/'))
                                        mkdirp.sync(options.uploadDir() + '/' + version + '/');

                                    counter++;
                                    var opts = options.imageVersions[version];
                                    imageMagick.resize({
                                        width: opts.width,
                                        height: opts.height,
                                        srcPath: image_path,
                                        dstPath: options.uploadDir() + '/' + version + '/' + fileInfo.name
                                    }, finish);
                                });
                            })
                        }

                        if (options.imageTypes.test(fileInfo.name)) {
                            _.each(options.imageVersions, function (value, version) {
                                // creating directory recursive
                                if (!fs.existsSync(options.uploadDir() + '/' + version + '/'))
                                    mkdirp.sync(options.uploadDir() + '/' + version + '/');

                                counter++;
                                var opts = options.imageVersions[version];
                                imageMagick.resize({
                                    width: opts.width,
                                    height: opts.height,
                                    srcPath: options.uploadDir() + '/' + fileInfo.name,
                                    dstPath: options.uploadDir() + '/' + version + '/' + fileInfo.name
                                }, finish);
                            });
                        }
                    }

                    if (!fs.existsSync(options.uploadDir() + '/'))
                        mkdirp.sync(options.uploadDir() + '/');

                    counter++;
                    fs.rename(file.path, options.uploadDir() + '/' + fileInfo.name, function (err) {
                        if (!err) {
                            generatePreviews();
                            finish();
                        } else {
                            var is = fs.createReadStream(file.path);
                            var os = fs.createWriteStream(options.uploadDir() + '/' + fileInfo.name);
                            is.on('end', function (err) {
                                if (!err) {
                                    fs.unlinkSync(file.path);
                                    generatePreviews();
                                }
                                finish();
                            });
                            is.pipe(os);
                        }
                    });
                }
            })
            .on('aborted', function () {
                _.each(tmpFiles, function (file) {
                    var fileInfo = map[path.basename(file)];
                    self.emit('abort', fileInfo);
                    fs.unlink(file);
                });
            })
            .on('error', function (e) {
                self.emit('error', e);
            })
            .on('progress', function (bytesReceived, bytesExpected) {
                if (bytesReceived > options.maxPostSize)
                    self.req.connection.destroy();
            })
            .on('end', finish)
            .parse(self.req);
    };

    UploadHandler.prototype.destroy = function () {
        var self = this,
            fileName = path.basename(decodeURIComponent(this.req.url));

        fs.unlink(options.uploadDir() + '/' + fileName, function (ex) {
            _.each(options.imageVersions, function (value, version) {
                fs.unlink(options.uploadDir() + '/' + version + '/' + fileName);
            });
            self.callback(!ex);
        });
    };

    UploadHandler.prototype.initUrls = function (fileInfo) {
        var baseUrl = (options.ssl ? 'https:' : 'http:') + '//' + this.req.headers.host;
        fileInfo.setUrl(null, baseUrl + options.uploadUrl());
        fileInfo.setUrl('delete', baseUrl + this.req.originalUrl);
        _.each(options.imageVersions, function (value, version) {
            if (fs.existsSync(options.uploadDir() + '/' + version + '/' + fileInfo.name)) {
                fileInfo.setUrl(version, baseUrl + options.uploadUrl() + '/' + version);
            }
        }, this);
    };

    return UploadHandler;
}

