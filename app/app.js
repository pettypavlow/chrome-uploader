require(["dexcom", "./datasource/mongolab"], function(dexcom, mongolab) {
var isWindows = !!~window.navigator.appVersion.indexOf("Win");
var attempts = 0;
var connect = function() {
	var chrome_notification_id = 0;
	var connectionErrorCB = function(notification_id, button) {
		chrome.notifications.onButtonClicked.removeListener(connectionErrorCB);
		if (notification_id != chrome_notification_id) return;

		if (button === 0) {
			attempts = 0;
			connect().then(onConnected,onConnectError);
		}
	};
	return new Promise(function(resolve, reject) {
		chrome.storage.local.get("config", function(local) {
			console.debug("[dexcom] loading");
			var serialport = local.config.serialport || (isWindows? "COM3": "/dev/tty.usbmodem");
			dexcom.connect(serialport).then(function() {
				console.debug("[dexcom] loaded");
				chrome.notifications.onButtonClicked.removeListener(connectionErrorCB);
				return dexcom.readFromReceiver(1);
			}, function(e) {
				console.log("[dexcom] rejected");
				if (attempts++ < 3) {
					connect().then(onConnect, onConnectError);
				} else {
					chrome.notifications.create("", {
						type: "basic",
						title: "Chromadex",
						message: "Could not connect to Dexcom receiver. Unplug it and plug it back in. Be gentle, Dexcom's USB port is fragile. I like to unplug from the computer's side.",
						iconUrl: "/public/assets/error.png",
						buttons: [{
							title: "Try again"
						}, {
							title: "Cancel"
						}]
					}, function(notification_id) {
						console.log(arguments);
						chrome_notification_id = notification_id;
						attempts = 0;
						chrome.notifications.onButtonClicked.addListener(connectionErrorCB);
					});
					console.log(e);
				}
				reject(e);
			}).then(function(d) {
				console.debug("[dexcom] read; disconnecting");
				dexcom.disconnect();
				resolve(d);
			}, function(d) {
				console.debug("[dexcom] error occured; bailing out");
				reject(d);
			});
		});
	});
},
onConnected = function(data) {
	var lastNewRecord = Date.now();

	// update my db
	var updateLocalDb = function(data) {
		return new Promise(function(resolve) {
			chrome.storage.local.get(["egvrecords", "config"], function(storage) {
				var existing = storage.egvrecords || [];
				var max_existing = existing.length > 0?  existing[existing.length - 1].displayTime : 0;
				var new_records = data.filter(function(egv) {
					return +egv.displayTime > max_existing;
				}).map(function(egv) {
					return {
						displayTime: +egv.displayTime,
						bgValue: egv.bgValue,
						trend: egv.trend
					};
				});
				if (new_records.length === 0) {
					if (lastNewRecord + (5).minutes() < Date.now()) {
						console.log("[updateLocalDb] Something's wrong. We should have new data by now.");
					}
				} else {
					lastNewRecord = Date.now();
				}
				new_records = new_records.filter(function(row) {
					return row.bgValue > 30;
				});
				var to_save = existing.concat(new_records);
				to_save.sort(function(a,b) {
					return a.displayTime - b.displayTime;
				});
				chrome.storage.local.set({ egvrecords: to_save }, console.debug.bind(console, "[updateLocalDb] Saved results"));
				console.log("%i new records", new_records.length);

				resolve();
			});
		});

	};

	// do it
	updateLocalDb(data);

	// again and again
	setTimeout(function() {
		console.log("Attempting to refresh data");
		connect().then(onConnected, onConnectError);
	}, (60).seconds());
},
onConnectError = function(){
	console.log(arguments);
};
connect().then(onConnected, onConnectError);

$(function() {
	// event handlers
	$('#reset').confirmation({
		title: "Are you sure? This will delete all your data and cannot be undone.",
		onConfirm: function(e) {
			chrome.storage.local.set({
				egvrecords: []
			}, function() {
				console.log("removed records");
				$('#reset').confirmation('hide');
			});
		}
	});
	$('#import').confirmation({
		title: "You usually only need to download once. Chromadex automatically gets the last 18h data, but this will download everything else (So if you plugged in yesterday, no need to do this. If you plugged in last week, or this is your first time using Chromadex, go ahead)",
		btnOkLabel: "Download",
		btnOkClass: "btn btn-sm btn-primary",
		onConfirm: function(b){
			chrome.notifications.create("", {
				type: "progress",
				title: "Chromadex",
				message: "Downloading entire history from Dexcom receiver.",
				iconUrl: "/public/assets/icon.png",
				progress: 0
			}, function(notification_id) {
				var i = 1;
				var data = [];
				var compile = function(i) {
					return new Promise(function(resolve,reject) {
						dexcom.readFromReceiver(i).then(function(d) {
							data.push(d);

							if (d.length) {
								resolve(d);
							} else {
								reject();
							}
						});
					});
				},
				reader = function() {
					compile(i).then(function() {
						chrome.notifications.update(notification_id, {
							progress: i
						}, function() { });
						i++;
						reader();
					}, function() { // no more data
						chrome.notifications.update(notification_id, {
							progress: 85,
							message: "Still downloading. This part is harder and this might appear to lock up for 30 seconds. No big deal."
						}, function() {
							setTimeout(function() {
							chrome.storage.local.get("egvrecords", function(values) {
								dexcom.disconnect();
								var existing = values.egvrecords;
								var existing_ts = existing.map(function(row) {
									return row.displayTime;
								});
								var max_existing = existing.length > 0?  existing[existing.length - 1].displayTime : 0;
								var new_records = Array.prototype.concat.apply([], data).map(function(egv) {
									return {
										displayTime: +egv.displayTime,
										bgValue: egv.bgValue,
										trend: egv.trend
									};
								}).filter(function(row) {
									return existing_ts.filter(function(ts) {
										return ts == row.displayTime;
									}).length === 0;
								}).filter(function(row) {
									return row.bgValue > 30;
								});
								var to_save = existing.concat(new_records);
								to_save.sort(function(a,b) {
									return a.displayTime - b.displayTime;
								});
								chrome.storage.local.set({ egvrecords: to_save },
									console.debug.bind(console, "[updateLocalDb] Saved results")
								);
								chrome.notifications.clear(notification_id, function() { });
								console.log("%i new records (about %i days)", new_records.length, Math.ceil(new_records.length / 216)); // 1 page holds about 18h (3/4 * 288 rec / day)
							});
							}, 300);
						});
					});
				};
				dexcom.connect().then(reader);
			});
		}
	});
	$('.dropdown-toggle').dropdown();
	$("#menuinsights").click(function() {
		chrome.app.window.create('app/report/insights.html', {
			id: "insightsreport",
			bounds: {
				width: 800,
				height: 600
			}
		});
	});
	$("#menudailystats").click(function() {
		chrome.app.window.create('app/report/dailystats.html', {
			id: "dailystatsreport",
			bounds: {
				width: 600,
				height: 650
			}
		});
	});
	$("#menudistribution").click(function() {
		chrome.app.window.create('app/report/glucosedistribution.html', {
			id: "glucosedistribution",
			bounds: {
				width: 960,
				height: 400
			}
		});
	});
	$("#menuhourlystats").click(function() {
		chrome.app.window.create('app/report/hourlystats.html', {
			id: "hourlystats",
			bounds: {
				width: 960,
				height: 800
			}
		});
	});
	$("#openoptions").click(function(){
		new Promise(function(done) {
			chrome.storage.local.get("config", function(config) {
				config.config.serialport = config.config.serialport || "/dev/tty.usbmodem";
				config.config.unit = config.config.unit || "mgdl";
				done(config.config);
			});
		}).then(function(config) {
			console.log(config);
			function getValue(param, options) {
				var parts = param.split(".");
				var key = parts.shift();
				if (parts.length > 0) {
					return getValue(parts.join("."), options[key]);
				} else {
					return (typeof options == "object" && key in options)? options[key]: "";
				}
			}
			$("#optionsui input,#optionsui select").map(function(ix) {
				$(this).val(getValue(this.name, config));
			});
		});
		$("#optionsui").show();
		$("#receiverui").hide();

	});
	chrome.serial.getDevices(function(ports) {
		var isWindows = !!~window.navigator.appVersion.indexOf("Win");
		document.getElementById("serialportlist").innerHTML += (isWindows? "<li>Default is <code>COM3</code>. Other's available when Chromadex started include</li>": "<li>Default is <code>/dev/tty.usbmodem</code>. Others available when Chromadex started include</li>") + ports.map(function(sp) {
			if (!isWindows || sp.path != "COM3") return "<li><code>" + sp.path + "</code></li>"; else return "";
		}).join("")
		$("#serialportlist code").click(function(event) {
			$("input[name=serialport]").val(this.textContent);
		})
	});
	$("#savesettings").click(function() {
		chrome.storage.local.set({
			config: $("#optionsui input, #optionsui select").toArray().reduce(function(out, field) {
				var parts = field.name.split(".");
				var key = parts.shift();
				var working = out;
				while (parts.length > 0) {
					if (!(key in working)) {
						working[key] = {};
					}
					working = working[key];
					key = parts.shift();
				}
				working[key] = field.value;
				return out;
			}, {})
		}, function() {
			console.log("saved settings");
			$("#optionsui").hide();
			$("#receiverui").show();
		});
	});
	$("#resetchanged").click(function() {
		$("#optionsui").hide();
		$("#receiverui").show();
	});
	$("#testconnection").click(function() {
		var config = $("#optionsdatabase input").toArray().reduce(function(out, field) {
			out[field.name] = field.value;
			return out;
		}, {});
		var worker = function() { };
		var applyChoice = function(notification_id, button) {
			worker.apply(this,arguments);
		}
		chrome.notifications.onButtonClicked.removeListener(applyChoice);
		mongolab.testConnection(config["mongolab.apikey"], config["mongolab.database"], config["mongolab.collection"]).then(function ok() {
			console.log("[mongolab] connection check ok");
			chrome.notifications.create("", {
				type: "message",
				title: "Chromadex",
				message: "This mongolab configuration checks out ok",
				iconUrl: "/public/assets/icon.png"
			}, function(chrome_notification_id) {
			});
		}, function fail(error) {
			console.log("[mongolab] " + error.error, error.avlb);
			chrome.notifications.create("", {
				type: "list",
				title: error.error + ": " + error.selected,
				message: "Here are some possible valid answers",
				iconUrl: "/public/assets/icon.png",
				buttons: (error.avlb.length > 0 && error.avlb.length <= 2)? error.avlb.map(function(choice) {
					return { title: "Use " + choice };
				}) : undefined,
				items: error.avlb.map(function(option) {
					return {
						title: option,
						message: error.type
					};
				})
			}, function(chrome_notification_id) {
				worker = function(notification_id, button) {
					if (notification_id == chrome_notification_id) {
						var selection = error.avlb[button];
						var fields = {
							database: "#options-database-name",
							collection: "#options-database-collection",
							apikey: "#options-database-apiuser"
						};
						$(fields[error.type]).val(selection);
					}
					chrome.notifications.onButtonClicked.removeListener(applyChoice);
				}
				chrome.notifications.onButtonClicked.addListener(applyChoice);
			});
		});
	});
});

});
