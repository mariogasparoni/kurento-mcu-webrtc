/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var url = require('url');
var cookieParser = require('cookie-parser');
var express = require('express');
var session = require('express-session')
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED=0;

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',    // Kurento Application IP
        ws_uri: 'ws://localhost:8888/kurento'    // Kurento Server IP
    }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Management of sessions
 */
app.use(cookieParser());

var sessionHandler = session({
    secret : 'none',
    rolling : true,
    resave : true,
    saveUninitialized : true
});
const kilo = 1024;

const BIT_RATE = 4096; //kbps
app.use(sessionHandler);

/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};
var kurentoClient = null;
var compositeHub = null;
var mediaPipeline = null;

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/kurentomcu'
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws, req) {
    var sessionId = null;
    var websocketId = null; // differ tabs
    var request = req;
    var response = {
        writeHead : {}
    };

    sessionHandler(request, response, function(err) {
        sessionId = request.session.id;
        console.log('Connection received with sessionId ' + sessionId);
        var websocketId = request.headers['sec-websocket-key'];
    });

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId, websocketId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' , ' + websocketId + ' closed');
        stop(sessionId, websocketId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        //console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'start':
            sessionId = request.session.id;
            websocketId = request.headers['sec-websocket-key'];
            start(sessionId, websocketId, ws, message.sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id : 'error',
                        message : error
                    }));
                }
                ws.send(JSON.stringify({
                    id : 'startResponse',
                    sdpAnswer : sdpAnswer
                }));
            });
            break;

        case 'stop':
            stop(sessionId, websocketId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, websocketId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function getMediaPipeline(callback) {
  if (mediaPipeline) {
    return callback(null, mediaPipeline);
  } else {
    kurentoClient.create('MediaPipeline', function(error, pipeline) {
        if (error) {
            return callback(error);
        }
        console.log('Creating MediaPipeline and Composite...');
        pipeline.listeners = 0;
        mediaPipeline = pipeline;
        return callback(null,pipeline);
    });
  }
}

function start(sessionId, websocketId, ws, sdpOffer, callback) {
    if (!sessionId || !websocketId) {
        return callback('Cannot use undefined sessionId/websocketId');
    }

    console.log('Adding user to MCU [ ' + sessionId + ', '  +  websocketId + ' ]');
    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        getMediaPipeline( function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            pipeline.listeners++;

            createMediaElements(pipeline, ws, function(error, webRtcEndpoint,
              hubPort) {
                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[sessionId][websocketId]) {
                    while(candidatesQueue[sessionId][websocketId].length) {
                        var candidate = candidatesQueue[sessionId][websocketId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                connectMediaElements(webRtcEndpoint, hubPort,
                  function(error) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    webRtcEndpoint.on('OnIceCandidate', function(event) {
                        var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                        ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                        candidate.candidate = candidate.candidate.replace('10.0.3.96','10.0.0.2');
                        ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                    });

                    webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        if (!sessions[sessionId]) {
                          sessions[sessionId] = {};
                        }
                        sessions[sessionId][websocketId] = {
                            'pipeline' : pipeline,
                            'webRtcEndpoint' : webRtcEndpoint,
                            'hubPort' : hubPort
                        }
                        return callback(null, sdpAnswer);
                    });

                    webRtcEndpoint.gatherCandidates(function(error) {
                        if (error) {
                            return callback(error);
                        }
                    });
                });
            });
        });
    });
}

function createMediaElements(pipeline, ws, callback) {
      pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
          if (error) {
              return callback(error);
          }
          var maxbps = Math.floor( BIT_RATE * kilo);
          webRtcEndpoint.setMinOutputBitrate(maxbps, function (error) {
              //console.log('[media] Min Output Bitrate (bps) ' + maxbps);
              if (error) {
                console.log('[media]  Error: ' + error);
              }
              webRtcEndpoint.setMaxOutputBitrate(maxbps, function (error) {
                //console.log('[media] Min Output Bitrate (bps) ' + maxbps);
                if (error) {
                  console.log('[media]  Error: ' + error);
                }
                if (compositeHub) {
                  compositeHub.createHubPort(function(error, hubPort){
                    if (error){
                      return callback(error);
                    }
                    hubPort.setMinOutputBitrate(maxbps, function (error) {
                      hubPort.setMaxOutputBitrate(maxbps, function (error){
                        return callback(null, webRtcEndpoint, hubPort);
                      });
                    });
                  });
                }
                else
                {
                  pipeline.create('Composite', function (error, composite) {
                    if (error) {
                      return callback(error);
                    }

                    compositeHub = composite;

                    composite.createHubPort(function(error, hubPort){
                      if (error){
                        return callback(error);
                      }
                      hubPort.setMinOutputBitrate(maxbps, function (error) {
                        hubPort.setMaxOutputBitrate(maxbps, function (error){
                          return callback(null, webRtcEndpoint, hubPort);
                      });
                    });
                  });
                });
              }
            });
        });
    });
}

function connectMediaElements(webRtcEndpoint, hubPort, callback) {
    webRtcEndpoint.connect(hubPort, function(error) {
        if (error) {
            return callback(error);
        }

        hubPort.connect(webRtcEndpoint, function (error){
          if (error) {
            return callback(error);
          }

          return callback(null);
        });
    });
}

function stop(sessionId, websocketId) {
    if (sessions[sessionId] && sessions[sessionId][websocketId]) {
        console.log('Removing user from MCU [ ' + sessionId + ', '  +  websocketId + ' ]');
        // var pipeline = sessions[sessionId].pipeline;
        // console.info('Releasing pipeline');
        // pipeline.release();

        var hubPort = sessions[sessionId][websocketId].hubPort;
        var webRtcEndpoint = sessions[sessionId][websocketId].webRtcEndpoint;
        if (hubPort) {
          hubPort.release(function (error) {
            if (webRtcEndpoint) {
              webRtcEndpoint.release();
            }

            delete sessions[sessionId][websocketId];
            delete candidatesQueue[sessionId][websocketId];
            if (mediaPipeline) {
              mediaPipeline.listeners--;
              if (mediaPipeline.listeners < 1) {
                mediaPipeline.release();
                mediaPipeline = null;
                compositeHub = null;
                console.log('Removing MediaPipeline and Composite...');
              }
            }
          });
        }
    }
}

process.on('SIGINT', function (error, signal){
  console.log('Stopping application...');
  if (mediaPipeline) {
    console.log('Removing MediaPipeline and Composite...');
    mediaPipeline.release(function (error) {
      exit();
    });
  } else {
    exit();
  }
});

function exit() {
  console.log('Bye!');
  process.exit();
}

function onIceCandidate(sessionId, websocketId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);

    if (sessions[sessionId] && sessions[sessionId][websocketId]) {
        //console.info('Sending candidate');
        var webRtcEndpoint = sessions[sessionId][websocketId].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        //console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
          candidatesQueue[sessionId] = {};
          candidatesQueue[sessionId][websocketId] = [];
        } else {
          if (!candidatesQueue[sessionId][websocketId]) {
            candidatesQueue[sessionId][websocketId] = [];
          }
        }
        candidatesQueue[sessionId][websocketId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
