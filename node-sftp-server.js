// TODO: Rewrite this shit!!!

"use strict";

var extend = function(child, parent) {
		for (var key in parent) {
			if (hasProp.call(parent, key)) {
				child[key] = parent[key];
			}
		}
		function ctor() { this.constructor = child; }

		ctor.prototype = parent.prototype;
		child.prototype = new ctor();
		child.__super__ = parent.prototype;
		return child;
	},
	hasProp = {}.hasOwnProperty,
	slice = [].slice;

var ssh2 = require('ssh2');
var { STATUS_CODE, flagsToString } = ssh2.utils.sftp;

var tmp = require('tmp');
tmp.setGracefulCleanup();

var Readable = require('stream').Readable;
var Writable = require('stream').Writable;
var Transform = require('stream').Transform;

var EventEmitter = require("events").EventEmitter;
var fs = require('fs');

var moment = require('moment');

var constants = require('constants');
const { PassThrough } = require("node:stream");

var getLongname = function(name, attrs, owner = 'nobody', group = 'nogroup') {
	let longname = '';

	if (attrs.type === fs.constants.S_IFREG) {
		longname += '-'
	}
	if (attrs.type === fs.constants.S_IFDIR) {
		longname += 'd';
	}

	let permissions = attrs.permissions.toString().split('');
	permissions.forEach((el) => {
		el == 1 ? longname += '--x' : null;
		el == 2 ? longname += '-w-' : null;
		el == 3 ? longname += '-wx' : null;
		el == 4 ? longname += 'r--' : null;
		el == 5 ? longname += 'r-x' : null;
		el == 6 ? longname += 'rw-' : null;
		el == 7 ? longname += 'rwx' : null;
	});

	longname += ' 0';
	longname += ' ' + owner + ' ' + group + ' ';
	longname += attrs.size ? attrs.size : '0';
	longname += ' ' + moment.unix(attrs.mtime).format('MMM DD HH:mm');
	longname += ' ' + name;

	return longname;
};

var parseClientInfo = function(info) {
	if (info.ip) {
		info.ipv4 = info.ip.match(/\d{1,3}.\d{1,3}.\d{1,3}.\d{1,3}/);
	}
	return info;
};

var Responder = (function(superClass) {
	extend(Responder, superClass);

	Responder.Statuses = {
		"denied": "PERMISSION_DENIED",
		"nofile": "NO_SUCH_FILE",
		"end": "EOF",
		"ok": "OK",
		"fail": "FAILURE",
		"bad_message": "BAD_MESSAGE",
		"unsupported": "OP_UNSUPPORTED"
	};

	function Responder(sftpStream1, req1) {
		var fn, methodname, ref, symbol;
		this.req = req1;
		this.sftpStream = sftpStream1;
		ref = this.constructor.Statuses;
		fn = (function(_this) {
			return function(symbol) {
				return _this[methodname] = function() {
					_this.done = true;
					return _this.sftpStream.status(_this.req, STATUS_CODE[symbol]);
				};
			};
		})(this);
		for (methodname in ref) {
			symbol = ref[methodname];
			fn(symbol);
		}
	}

	return Responder;

})(EventEmitter);

var DirectoryEmitter = (function(superClass) {
	extend(DirectoryEmitter, superClass);

	function DirectoryEmitter(sftpStream1, req1) {
		this.sftpStream = sftpStream1;
		this.req = req1 != null ? req1 : null;
		this.stopped = false;
		this.done = false;
		DirectoryEmitter.__super__.constructor.call(this, sftpStream1, this.req);
	}

	DirectoryEmitter.prototype.request_directory = function(req) {
		this.req = req;
		if (!this.done) {
			return this.emit("dir");
		} else {
			return this.end();
		}
	};

	DirectoryEmitter.prototype.file = function(name, attrs) {
		if (typeof attrs === 'undefined') {
			attrs = {};
		}
		this.stopped = this.sftpStream.name(this.req, {
			filename: name.toString(),
			longname: getLongname(name.toString(), attrs),
			attrs: attrs
		});
	};

	return DirectoryEmitter;

})(Responder);

var ContextWrapper = (function() {
	function ContextWrapper(ctx1, server) {
		this.ctx = ctx1;
		this.server = server;
		this.method = this.ctx.method;
		this.username = this.ctx.username;
		this.password = this.ctx.password;
	}

	ContextWrapper.prototype.reject = function(methodsLeft, isPartial) {
		return this.ctx.reject(methodsLeft, isPartial);
	};

	ContextWrapper.prototype.accept = function(callback) {
		if (callback == null) {
			callback = function() {};
		}
		this.ctx.accept();
		return this._session_start_callback = callback;
	};

	return ContextWrapper;

})();

var debug = function(msg) {};

var SFTPServer = (function(superClass) {
	extend(SFTPServer, superClass);

	function SFTPServer(options) {
		if (options.debug) {
			debug = function(msg) { console.log(msg); };
			options.debug = debug;
		}
		options.hostKeys = options.hostKeys.map(key => fs.readFileSync(key))
		SFTPServer.options = options;
		this.server = new ssh2.Server(options, (function(_this) {
			return function(client, info) {
				client.on('authentication', function(ctx) {
					debug("SFTP Server: on('authentication')");
					_this.clientInfo = parseClientInfo(info);
					client.auth_wrapper = new ContextWrapper(ctx, _this);
					return _this.emit("connect", client.auth_wrapper);
				});
        client.on('error', function(err) {
          debug("SFTP Server: error");
          return _this.emit("error", err);
        });
				client.on('end', function() {
					debug("SFTP Server: on('end')");
					return _this.emit("end");
				});
				return client.on('ready', function(channel) {
					return client.on('session', function(accept, reject) {
						var session;
						session = accept();
						return session.on('sftp', function(accept, reject) {
							var sftpStream;
							sftpStream = accept();

							// This is necessary to properly terminate the connection for some
    						// clients (ex: Rclone, sftp) that send EOF when requesting to close the
    						// connection.
							// https://github.com/mscdex/ssh2/pull/1111
							session.on('eof', function() {
								sftpStream.end();
							});

							session = new SFTPSession(sftpStream);

							return client.auth_wrapper?._session_start_callback?.(session);
						});
					});
				});
			};
		})(this));
	}

	SFTPServer.prototype.listen = function(port) {
		return this.server.listen(port);
	};

	return SFTPServer;

})(EventEmitter);

module.exports = SFTPServer

var Statter = (function() {
	function Statter(sftpStream1, reqid1) {
		this.sftpStream = sftpStream1;
		this.reqid = reqid1;
	}

	Statter.prototype.is_file = function() {
		return this.type = constants.S_IFREG;
	};

	Statter.prototype.is_directory = function() {
		return this.type = constants.S_IFDIR;
	};

	Statter.prototype.file = function() {
		return this.sftpStream.attrs(this.reqid, this._get_statblock());
	};

	Statter.prototype.nofile = function() {
		return this.sftpStream.status(this.reqid, STATUS_CODE.NO_SUCH_FILE);
	};

	Statter.prototype._get_mode = function() {
		return this.type | this.permissions;
	};

	Statter.prototype._get_statblock = function() {
		return {
			mode: this._get_mode(),
			uid: this.uid,
			gid: this.gid,
			size: this.size,
			atime: this.atime,
			mtime: this.mtime
		};
	};

	return Statter;

})();

var SFTPFileStream = (function(superClass) {
	extend(SFTPFileStream, superClass);

	function SFTPFileStream() {
		return SFTPFileStream.__super__.constructor.apply(this, arguments);
	}

	SFTPFileStream.prototype._read = function(size) {};

	return SFTPFileStream;

})(Readable);

var SFTPSession = (function(superClass) {
	extend(SFTPSession, superClass);

	SFTPSession.Events = [
		"REALPATH", "STAT", "LSTAT", "FSTAT",
		"OPENDIR", "CLOSE", "REMOVE", "READDIR",
		"OPEN", "READ", "WRITE", "RENAME",
		"MKDIR", "RMDIR", "SETSTAT"
	];

	function SFTPSession(sftpStream1) {
		var event, fn, i, len, ref;
		this.sftpStream = sftpStream1;
		this.max_filehandle = 0;
		this.handles = {};
		ref = this.constructor.Events;
		fn = (function(_this) {
			return function(event) {
				return _this.sftpStream.on(event, function() {
					var args;
					args = 1 <= arguments.length ? slice.call(arguments, 0) : [];
					debug('DEBUG: SFTP Session Event: ' + event);
					return _this[event].apply(_this, args);
				});
			};
		})(this);
		for (i = 0, len = ref.length; i < len; i++) {
			event = ref[i];
			fn(event);
		}
	}

	SFTPSession.prototype.fetchhandle = function() {
		var prevhandle;
		prevhandle = this.max_filehandle;
		this.max_filehandle++;
		return new Buffer(prevhandle.toString());
	};

	SFTPSession.prototype.REALPATH = function(reqid, path) {
		var callback;
		if (EventEmitter.listenerCount(this, "realpath")) {
			callback = (function(_this) {
				return function(name) {
					return _this.sftpStream.name(reqid, {
						filename: name,
						longname: "-rwxrwxrwx 1 foo foo 3 Dec 8 2009 " + name,
						attrs: {}
					});
				};
			})(this);
			return this.emit("realpath", path, callback);
		} else {
			return this.sftpStream.name(reqid, {
				filename: path,
				longname: path,
				attrs: {}
			});
		}
	};

	SFTPSession.prototype.do_stat = function(reqid, path, kind) {
		if (EventEmitter.listenerCount(this, "stat")) {
			return this.emit("stat", path, kind, new Statter(this.sftpStream, reqid));
		} else {
			console.log("WARNING: No stat function for " + kind + ", all files exist!");
			return this.sftpStream.attrs(reqid, {
				filename: path,
				longname: path,
				attrs: {}
			});
		}
	};

	SFTPSession.prototype.STAT = function(reqid, path) {
		return this.do_stat(reqid, path, 'STAT');
	};

	SFTPSession.prototype.LSTAT = function(reqid, path) {
		return this.do_stat(reqid, path, 'LSTAT');
	};

	SFTPSession.prototype.FSTAT = function(reqid, handle) {
		return this.do_stat(reqid, this.handles[handle].path, 'FSTAT');
	};

	SFTPSession.prototype.OPENDIR = function(reqid, path) {
		var diremit;
		diremit = new DirectoryEmitter(this.sftpStream, reqid);
		diremit.on("newListener", (function(_this) {
			return function(event, listener) {
				var handle;
				if (event !== "dir") {
					return;
				}
				handle = _this.fetchhandle();
				_this.handles[handle] = {
					mode: "OPENDIR",
					path: path,
					loc: 0,
					responder: diremit
				};
				return _this.sftpStream.handle(reqid, handle);
			};
		})(this));
		return this.emit("readdir", path, diremit);
	};

	SFTPSession.prototype.READDIR = function(reqid, handle) {
		var ref;
		if (((ref = this.handles[handle]) != null ? ref.mode : void 0) !== "OPENDIR") {
			return this.sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
		}
		return this.handles[handle].responder.request_directory(reqid);
	};

	SFTPSession.prototype.OPEN = function(reqid, pathname, flags, attrs) {
		var handle, rs, started, ts;
		var stringflags = flagsToString(flags);

		if (stringflags === 'r') {
			// Create a temporary file to hold stream contents.
			var options = {};
			if (SFTPServer.options.temporaryFileDirectory) {
				options.dir = SFTPServer.options.temporaryFileDirectory;
			}
			return tmp.file(options, function(err, tmpPath, fd, removeCallback) {
				if (err) {
					throw err;
				}
				handle = this.fetchhandle();
				this.handles[handle] = {
					mode: "READ",
					path: pathname,
					finished: false,
					tmpPath: tmpPath,
					tmpFile: fd,
					removeCallback,
				};
				var writestream = fs.createWriteStream(tmpPath, { highWaterMark: 256 * 1024 });
				writestream.on("finish", function() {
					this.handles[handle].finished = true;
				}.bind(this));
				this.emit("readfile", pathname, writestream);
				return this.sftpStream.handle(reqid, handle);
			}.bind(this));
		}
		if (stringflags === 'w' || stringflags === 'wx') {
			const proxy = new PassThrough();
			proxy.setMaxListeners(100);
			handle = this.fetchhandle();
			this.handles[handle] = {
				mode: "WRITE",
				path: pathname,
				stream: proxy,
				processed: 0
			};
			this.sftpStream.handle(reqid, handle);
			this.emit("writefile", pathname, proxy);

			return true;
		}

		return this.emit("error", new Error("Unknown open flags: " + stringflags));

	};

	SFTPSession.prototype.READ = function(reqid, handle, offset, length) {
		var localHandle = this.handles[handle];

		// Once our readstream is at eof, we're done reading into the
		// buffer, and we know we can check against it for EOF state.
		if (localHandle.finished) {
			return fs.stat(localHandle.tmpPath, function(err, stats) {
				if (err) {
					throw err;
				}

				if (offset >= stats.size) {
					return this.sftpStream.status(reqid, STATUS_CODE.EOF);
				} else {
					var buffer = Buffer.alloc(length);
					return fs.read(localHandle.tmpFile, buffer, 0, length, offset, function(err, bytesRead, buffer) {
						return this.sftpStream.data(reqid, buffer.slice(0, bytesRead));
					}.bind(this));
				}
			}.bind(this));
		}

		// If we're not at EOF from the buffer yet, we either need to put more data
		// down the wire, or need to wait for more data to become available.
		return fs.stat(localHandle.tmpPath, function(err, stats) {
			if (stats.size >= offset + length) {
				var buffer = Buffer.alloc(length);
				return fs.read(localHandle.tmpFile, buffer, 0, length, offset, function(err, bytesRead, buffer) {
					return this.sftpStream.data(reqid, buffer.slice(0, bytesRead));
				}.bind(this));
			} else {
				// Wait for more data to become available.
				setTimeout(function() {
					this.READ(reqid, handle, offset, length);
				}.bind(this), 50);
			}
		}.bind(this));
	};

	SFTPSession.prototype.WRITE = function(reqid, handle, offset, data) {
		const stream = this.handles[handle].stream;
		const written = stream.write(data);

		if (!written) {
			// Wait for drain event to avoid stream buffer overflow
			stream.once('drain', () => {
				this.sftpStream.status(reqid, STATUS_CODE.OK);
			});
		} else {
			this.sftpStream.status(reqid, STATUS_CODE.OK);
		}

		return true;
	};

	SFTPSession.prototype.CLOSE = function(reqid, handle) {
		//return this.sftpStream.status(reqid, STATUS_CODE.OK);
		if (this.handles[handle]) {
			switch (this.handles[handle].mode) {
				case "OPENDIR":
					this.handles[handle].responder.emit("end");
					delete this.handles[handle];
					return this.sftpStream.status(reqid, STATUS_CODE.OK);
				case "READ":
					this.handles[handle].removeCallback?.();
					delete this.handles[handle];
					return this.sftpStream.status(reqid, STATUS_CODE.OK);
				case "WRITE":
					this.handles[handle].stream.end();
					delete this.handles[handle]; //can't delete it while it's still going, right?
					return this.sftpStream.status(reqid, STATUS_CODE.OK);
				default:
					return this.sftpStream.status(reqid, STATUS_CODE.FAILURE);
			}
		}
	};

	SFTPSession.prototype.REMOVE = function(reqid, path) {
		return this.emit("delete", path, new Responder(this.sftpStream, reqid));
	};

	SFTPSession.prototype.RENAME = function(reqid, oldPath, newPath) {
		return this.emit("rename", oldPath, newPath, new Responder(this.sftpStream, reqid));
	};

	SFTPSession.prototype.MKDIR = function(reqid, path) {
		return this.emit("mkdir", path, new Responder(this.sftpStream, reqid));
	};

	SFTPSession.prototype.RMDIR = function(reqid, path) {
		return this.emit("rmdir", path, new Responder(this.sftpStream, reqid));
	};

	SFTPSession.prototype.SETSTAT = function(reqid, path, attrs) {
		return this.emit("setstat", path, attrs, new Responder(this.sftpStream, reqid));
	};

	return SFTPSession;

})(EventEmitter);
