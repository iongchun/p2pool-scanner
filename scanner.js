
var fs = require('fs'),
    http = require('http'),
    exec = require('child_process').exec,
	_ = require('underscore'),
    Geo = require('./geo');

function dpc(t,fn) { if(typeof(t) == 'function') setTimeout(t,0); else setTimeout(fn,t); }

var number_units = ['k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];

function float2int (value) {
    return value | 0;
}

function nice_number(n) {
    var f = 0;
    var i = -1;
    //console.log("n=", n);
    while (n >= 1000) {
        if ((i+1) >= number_units.length) {
            return "" + n + " " + number_units[i];
        }
        f = n % 1000;
        n = n / 1000;
        i++;
        //console.log("i=", i, " n=", n, " f=", f);
    }
    if (i > 0) {
        n = float2int(n);
        if (n < 10) {
            f = float2int(f);
            if (f < 100) {
                f = "0" + f;
                if (f < 10)
                    f = "0" + f;
            }
        } else if (n < 100) {
            f = float2int(f / 10);
            if (f < 10)
                f = "0" + f;
        } else {
            f = float2int(f / 100);
        }
        return "" + n + ((f > 0) ? "." + f : "") + " " + number_units[i];
    }
    return n;
}

function Scanner(options) {

	var self = this;
    self.options = options;

    var config = eval('('+fs.readFileSync("scanner.cfg",'utf8')+')');
    var upload = fs.existsSync('upload.cfg') ? eval('('+fs.readFileSync("upload.cfg",'utf8')+')') : null;

    self.addr_pending = { }     // list of addresses waiting scan
    self.addr_digested = { }    // list of scanned addresses
    self.addr_working = { }     // list of working addresses
    self.share_addrs = { }      // map of share to ip:port
    self.dup_addrs = { }        // map of ip:port to ip:port

    self.geo = new Geo({ timeout : config.http_socket_timeout });

  	// -----------------------------------------
   	// local http server interface 
    if(config.http_port) 
    {
        var express = require('express');
        var app = express();
        app.configure(function(){
            app.use(express.bodyParser());
        });
        app.get('/', function(req, res) {
            var str = self.render();
            res.write(str);
            res.end();
        });
        
        http.createServer(app).listen(config.http_port, function() {
            console.log("HTTP server listening on port: ",config.http_port);    
        });
    }

    var logo = fs.readFileSync("resources/"+config.currency.toLowerCase()+".png","base64");
    if(logo)
        logo = "data:image/png;base64,"+logo;


    self.render = function() {
        var str = "<html><head>"
            +"<style>"
            +"body { font-family: Consolas; font-size: 14px; background-color: #fff; color: #000; }"
            +"a:link { text-decoration: none; color: #0051AD; }"
            +"a:visited { text-decoration: none; color: #0051AD; }"
            +"a:hover { text-decoration: none; color: #F04800; }"
            +".row-grey { background-color: #f3f3f3;  }"
            +".p2p {  width: 1168px; margin-left: 40px; border: 1px solid #aaa;  box-shadow: 2px 2px 2px #aaa; padding: 2px;  }"
            +".p2p-row { width: 1150px; padding: 10px; height: 16px; }"
            +".p2p-caption { width: 1150px; text-align: center;  background-color: #ddd; padding-top: 4px; padding-bottom: 8px;}"
            +".p2p div { float : left; }"
            +".p2p-ip { width: 200px; text-align:left; }"
            +".p2p-version { margin-left: 10px; width: 100px; text-align: left;}"
            +".p2p-fee { margin-left: 10px; width: 90px; text-align: right;}"
            +".p2p-hashrate { margin-left: 10px; width: 100px; text-align: right;}"
            +".p2p-effi { margin-left: 10px; width: 100px; text-align: right;}"
            +".p2p-shares { margin-left: 10px; width: 100px; text-align: right;}"
            +".p2p-uptime { margin-left: 10px; width: 100px; text-align: right;}"
            +".p2p-geo { margin-left: 40px; width: 248px; text-align: left;}"
            +"img { border: none;}"
            +"</style>"
            +"</head><body>";
        if(logo)
            str += "<div style='float:left;margin:16px;'><img src=\""+logo+"\" /></div><br style='clear:both;'/>";
        str += "<center><a href='https://github.com/forrestv/p2pool' target='_blank'>PEER TO PEER "+(config.currency.toUpperCase())+" MINING NETWORK</a> - PUBLIC NODE LIST<br/><span style='font-size:10px;color:#333;'>GENERATED ON: "+(new Date())+"</span></center><p/>"
        if(self.poolstats)
            str += "<center>Pool speed: "+nice_number(self.poolstats.pool_hash_rate)+"h/s (est. good shares: " + (self.pool_good_rate * 100).toFixed(2) + "%)</center>";
        var public_good_rate = (self.total_shares - self.orphan_shares - self.dead_shares) / self.total_shares;
        str += "<center>Currently observing "+(self.nodes_total || "N/A")+" nodes.<br/>"+_.size(self.addr_working)+" nodes (" + nice_number(self.total_hashrate) + "h/s"
            + (self.poolstats ? ", " + (self.total_hashrate / self.poolstats.pool_hash_rate * 100).toFixed(2) + "%" : "")
            + (public_good_rate ? ", good shares: " + (public_good_rate * 100).toFixed(2) + "%" : "")
            + ") are public with following IPs:</center><p/>";
        str += "<div class='p2p'>";
        str += "<div class='p2p-row p2p-caption'><div class='p2p-ip'>IP:port</div><div class='p2p-version'>Version</div><div class='p2p-fee'>Fee</div><div class='p2p-hashrate'>Hashrate</div><div class='p2p-effi'>Efficiency</div><div class='p2p-shares'>Shares</div><div class='p2p-uptime'>Uptime</div><div class='p2p-geo'>Location</div>";
        str += "</div><br style='clear:both;'/>";

        var dup_idx = 0;
        var dup_text = {};
        var list = _.sortBy(_.toArray(self.addr_working), function(o) { return o.good_rate && o.stats.shares.total ? -o.good_rate * o.good_rate * Math.log(o.stats.shares.total) : 0; })

        var row = 0;
        _.each(list, function(info) {
            var ip = info.ip;
            var port = info.port-1;
            var id = info.ip + ':' + info.port;
            var text = '';
            if (self.dup_addrs[id]) {
                var dup_id = self.dup_addrs[id];
                if (!dup_text[dup_id]) {
                    dup_text[dup_id] = ' (*' + dup_idx++ + ')';
                }
                text = dup_text[dup_id];
                //console.log('show dup for', id, ':', dup_id, text);
            }

            var version = info.stats.version ? info.stats.version.replace(/-g.*/, "") : "N/A";
            var uptime = info.stats ? (info.stats.uptime / 60 / 60 / 24).toFixed(1) : "N/A";
            var fee = (info.fee || 0).toFixed(2);
            var shares = info.stats.shares;
            var shares_show = shares.total ? (shares.total - shares.orphan - shares.dead) + " / " + shares.total : 0;
            var effi = info.good_rate && public_good_rate ? ((info.good_rate / public_good_rate) * 100).toFixed(2) + "%" : "N/A";

            str += "<div class='p2p-row "+(row++ & 1 ? "row-grey" : "")+"'><div class='p2p-ip'><a href='http://"+ip+":"+port+"' target='_blank'>"+ip+":"+port+text+"</a></div><div class='p2p-version'>"+version+"</div><div class='p2p-fee'>"+fee+"%</div><div class='p2p-hashrate'>"+nice_number(info.total_hashrate)+"h/s</div><div class='p2p-effi'>"+effi+"</div><div class='p2p-shares'>"+shares_show+"</div><div class='p2p-uptime'>"+uptime+" days</div>";
            str += "<div class='p2p-geo'>";
            if(info.geo) {
                str += "<a href='http://www.geoiptool.com/en/?IP="+info.ip+"' target='_blank'>"+info.geo.country+" "+"<img src='"+info.geo.img+"' align='absmiddle' border='0'/></a>";
            }
            str += "</div>";
            str += "</div>";
            str += "<br style='clear:both;'/>";
        })
        str += "</div><p/><br/>";
        str += "</body>"
        return str;
    }

    // setup flushing of rendered HTML page to a file (useful for uploading to other sites)
    if(config.flush_to_file_every_N_msec && config.flush_filename) {
        function flush_rendering() {
            var str = self.render();
            fs.writeFile(config.flush_filename, str, { encoding : 'utf8'});
            dpc(config.flush_to_file_every_N_msec, flush_rendering);
        }

        dpc(5000, flush_rendering);
    }

    // defer init
    dpc(function(){
        self.restore_working();
        self.update();
    })

    var p2pool_init = true;

    // main function that reloads 'addr' file from p2pool
    self.update = function() {
        var filename = config.addr_file;
        if(!fs.existsSync(filename)) {
            console.error("Unable to fetch p2pool address list from:",config.addr_file);
            filename = config.init_file;    // if we can't read p2pool's addr file, we just cycle on the local default init...
        }

        fs.readFile(filename, { encoding : 'utf8' }, function(err, data) {
            if(err) {
                console.error(err);
            }
            else {
                try {
                    var addr_list = JSON.parse(data);
                    self.inject(addr_list);                    

                    // main init
                    if(p2pool_init) {
                        p2pool_init = false;

                        // if we can read p2pool addr file, also add our pre-collected IPs
                        // if(filename != config.init_file) {
                            var init_addr = JSON.parse(fs.readFileSync(config.init_file, 'utf8'));
                            self.inject(init_addr);                    
                        //}

                        for(var i = 0; i < (config.probe_N_IPs_simultaneously || 1); i++)
                            self.digest();
                        dpc(60*1000, function() { self.store_working(); })
                    }
                }
                catch(ex) {
                    console.error("Unable to parse p2pool address list");
                    console.error(ex);
                }
            }

            dpc(1000 * 60, self.update);
        })
    }
    
    // store public pools in a file that reloads at startup
    self.store_working = function() {
        var data = JSON.stringify(self.addr_working);
        fs.writeFile(config.store_file, data, { encoding : 'utf8' }, function(err) {
            dpc(60*1000, self.store_working);
        })
    }

    self.calc_node = function(info) {
        info.total_hashrate = 0;
        for (var miner in info.stats.miner_hash_rates) {
            info.total_hashrate += info.stats.miner_hash_rates[miner];
        }
        var shares = info.stats.shares;
        if (shares.total) {
            info.good_rate = (shares.total - shares.orphan - shares.dead) / shares.total;
        }
        if (info.good_rate && info.stats.efficiency) {
            var current_good_rate = info.good_rate / info.stats.efficiency;
            if (self.pool_good_rate)
                self.pool_good_rate = (self.pool_good_rate + current_good_rate) / 2;
            else
                self.pool_good_rate = current_good_rate;
        }
        var has_dup = false;
        var old_dup_id;
        var id = info.ip + ':' + info.port;
        if (info.shares) {
            for (i = 0; i < info.shares.length; i++) {
                var share = info.shares[i];
                if (!self.share_addrs[share]) {
                    self.share_addrs[share] = {};
                } else {
                    for (var other_id in self.share_addrs[share]) {
                        if (other_id != id) {
                            if (!old_dup_id) {
                                if (self.dup_addrs[other_id]) {
                                    old_dup_id = self.dup_addrs[other_id];
                                } else {
                                    old_dup_id = other_id;
                                }
                                if (self.dup_addrs[id] != id) {
                                    //console.log('replace main to updated dup', id, 'old:', old_dup_id);
                                    self.dup_addrs[id] = id;
                                }
                            }
                            if (self.dup_addrs[other_id] != id) {
                                //console.log('replace main for dup', other_id, ': new:', id, 'old:', self.dup_addrs[other_id]);
                            }
                            self.dup_addrs[other_id] = id;
                            has_dup = true;
                        }
                    }
                }
                self.share_addrs[share][id] = id;
            }
        } else if (self.dup_addrs[id]) {
            old_dup_id = self.dup_addrs[id];
            if (old_dup_id != id) {
                //console.log('replace main to updated dup', id, 'old:', old_dup_id);
                self.dup_addrs[id] = id;
            }
            for (var other_id in self.dup_addrs) {
                if (self.dup_addrs[other_id] == old_dup_id) {
                    //console.log('replace main for dup', other_id, ': new:', id, 'old:', self.dup_addrs[other_id]);
                    self.dup_addrs[other_id] = id;
                    has_dup = true;
                }
            }
        }
        if (has_dup) {
            if (old_dup_id != id) {
                var oinfo = self.addr_working[old_dup_id];
                self.hide_node(oinfo);
                //console.log('hide old main dup', old_dup_id, 'and show new', id);
            }
        } else if (self.dup_addrs[id]) {
            //console.log('remove main for dup', id, ': no share');
            delete self.dup_addrs[id];
        }
        //console.log('show', id);
        self.total_hashrate += info.total_hashrate;
        self.total_shares += shares.total;
        self.orphan_shares += shares.orphan;
        self.dead_shares += shares.dead;
    }

    self.hide_node = function(info) {
        //console.log('hide', info.ip + ':' + info.port);
        self.total_hashrate -= info.total_hashrate;
        var shares = info.stats.shares;
        self.total_shares -= shares.total;
        self.orphan_shares -= shares.orphan;
        self.dead_shares -= shares.dead;
    }

    self.remove_node = function(info) {
        var id = info.ip + ':' + info.port;
        for (var share in self.share_addrs) {
            if (id in self.share_addrs[share]) {
                delete self.share_addrs[share][id];
            }
        }
        var is_dup = false;
        if (self.dup_addrs[id]) {
            var dup_id;
            if (self.dup_addrs[id] == id) {
                var has_dup = false;
                for (var other_id in self.dup_addrs) {
                    if (other_id != id && self.dup_addrs[other_id] == id) {
                        if (dup_id) {
                            has_dup = true;
                        } else {
                            dup_id = other_id;
                            self.calc_node(self.addr_working[dup_id]);
                        }
                        //console.log('switch main to', dup_id, 'for remain dup', other_id);
                        self.dup_addrs[other_id] = dup_id;
                    }
                }
            } else {
                is_dup = true;
                dup_id = self.dup_addrs[id];
                for (var other_id in self.dup_addrs) {
                    if (other_id != id && other_id != dup_id && self.dup_addrs[other_id] == dup_id) {
                        has_dup = true;
                    }
                }
            }

            //console.log('remove main', self.dup_addrs[id], 'for dup', id, ': removed');
            delete self.dup_addrs[id];

            if (dup_id && !has_dup) {
                //console.log('remove main for dup', dup_id, ': one left');
                delete self.dup_addrs[dup_id];
            }
        }
        if (is_dup) {
            //console.log('do not hide dup:', id);
        } else {
            self.hide_node(info);
        }
    }

    // reload public list at startup
    self.restore_working = function() {
        try {
            self.addr_working = JSON.parse(fs.readFileSync(config.store_file, 'utf8'));
            self.total_hashrate = 0;
            self.total_shares = 0;
            self.orphan_shares = 0;
            self.dead_shares = 0;
            self.pool_good_rate = 0;
            // migration from old key (ip) to new key (ip:port)
            var changed = false;
            for (var id in self.addr_working) {
                var info = self.addr_working[id];
                self.calc_node(info);
                if (!/:/.test(id)) {
                    console.log("old key: ", id)
                    delete self.addr_working[id];
                    id = info.ip + ':' + info.port;
                    console.log("new key: ", id);
                    self.addr_working[id] = info;
                    changed = true;
                }
            }
            if (changed) {
                self.store_working();
            }
        } catch(ex) { /*console.log(ex);*/ }
    }

    // inject new IPs from p2pool addr file
    self.inject = function(addr_list) {
        _.each(addr_list, function(info) {
            var ip = info[0][0];
            var port = info[0][1];
            var id = ip + ':' + port;

            if(!self.addr_digested[id] && !self.addr_pending[id]) {
                self.addr_pending[id] = { ip : ip, port : port }
            }

            self.nodes_total = _.size(self.addr_digested) + _.size(self.addr_pending);
        });
    }

    // as we scan pools, we fetch global info from them to update the page
    self.update_global_stats = function(poolstats) {
        self.poolstats = poolstats;
    }

    // execute scan of a single IP
    self.digest = function() {

        if(!_.size(self.addr_pending))
            return self.list_complete();

        var info = _.find(self.addr_pending, function() { return true; });
        var id = info.ip + ':' + info.port;
        delete self.addr_pending[id];
        self.addr_digested[id] = info;
        if (/(^127\.0\.0\.1)|(^10\.)|(^172\.1[6-9]\.)|(^172\.2[0-9]\.)|(^172\.3[0-1]\.)|(^192\.168\.)/.test(info.ip)) {
            if (self.addr_working[id]) {
                var oinfo = self.addr_working[id];
                self.remove_node(oinfo);
            }
            delete self.addr_working[id];
            return continue_digest();
        }
        // console.log("P2POOL DIGESTING:",info.ip);

        digest_local_stats(info, function(err, stats){
            if(!err && stats.protocol_version >= 1300) {
                // Exclude nodes lacking protocol_version or older than 1300
                if (self.addr_working[id]) {
                    if (!self.dup_addrs[id] || self.dup_addrs[id] == id) {
                        var oinfo = self.addr_working[id];
                        self.hide_node(oinfo);
                    }
                }
                info.stats = stats;
                info.fee   = stats.fee;

                digest_shares(info, function(err, shares) {
                    if(!err)
                        info.shares = shares;
                    self.calc_node(info);
                    self.addr_working[id] = info;
                    // console.log("FOUND WORKING POOL: ", info.ip);
                });
 
                digest_global_stats(info, function(err, stats) {
                    if(!err)
                        self.update_global_stats(stats);

                    if(!info.geo)
                        self.geo.get(info.ip, function(err, geo) {
                            if(!err)
                                info.geo = geo;

                            continue_digest();
                        });
                    else
                        continue_digest();
                });
            }
            else {
                if (self.addr_working[id]) {
                    var oinfo = self.addr_working[id];
                    self.remove_node(oinfo);
                }
                delete self.addr_working[id];
                continue_digest();
            }
        });

        function continue_digest() {
            self.working_size = _.size(self.addr_working);
            dpc(self.digest);
        }
    }

    // schedule restar of the scan once all IPs are done
    self.list_complete = function() {
        self.addr_pending = self.addr_digested;
        self.addr_digested = { }
        dpc(config.rescan_list_delay, self.digest);
    }

    // functions to fetch data from target node IP

    function digest_local_stats(info, callback) {

        var options = {
          host: info.ip,
          port: info.port-1,
          path: '/local_stats',
          method: 'GET'
        };

        self.request(options, callback);
    }

    function digest_shares(info, callback) {

        var options = {
          host: info.ip,
          port: info.port-1,
          path: '/web/my_share_hashes',
          method: 'GET'
        };

        self.request(options, callback);
    }

    function digest_global_stats(info, callback) {

        var options = {
          host: info.ip,
          port: info.port-1,
          path: '/global_stats',
          method: 'GET'
        };

        self.request(options, callback);
    }

    // make http request to the target node ip
    self.request = function(options, callback, is_plain)
    {    
        http_handler = http;
        var req = http_handler.request(options, function(res) {
            res.setEncoding('utf8');
            var result = '';
            res.on('data', function (data) {
                result += data;
            });

            res.on('end', function () {
                if(options.plain)
                    callback(null, result);
                else {
                    try {
                        var o = JSON.parse(result);
                        callback(null, o);
                    } catch(ex) {
                        console.error(ex);
                        callback(ex);
                    }
                }
            });
        });

        req.on('socket', function (socket) {
            socket.setTimeout(config.http_socket_timeout);  
            socket.on('timeout', function() {
                req.abort();
            });
        });

        req.on('error', function(e) {
            callback(e);
        });

        req.end();
    }

    if(upload && process.platform != 'win32') {

        function do_upload() {

            if(upload.ftp) {
                var ftp = upload.ftp;
                if(!ftp.address || !ftp.username || !ftp.password)
                    return console.error("upload.cfg ftp configuration must contain target address, username and password");
                var cmd = "curl -T "+config.flush_filename+" "+ftp.address+" --user "+ftp.address+":"+ftp.password;
                exec(cmd, function(error){ if(error) console.error(error); });
            }

            if(upload.scp) {
                var scp = upload.scp;
                if(!scp.address)
                    return console.error("upload.cfg scp configuration must contain target address");
                var cmd = "scp -q ./"+config.flush_filename+" "+scp.address;
                exec(cmd, function(error){ if(error) console.error(error); });
            }

            dpc(config.upload_interval, do_upload);
        }

        dpc(5000, do_upload);
    }
    else
        console.log("upload.cfg not found, rendering available only on the local interface");
}


GLOBAL.scanner = new Scanner();


//  
