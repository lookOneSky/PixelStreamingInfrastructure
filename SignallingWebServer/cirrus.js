// Copyright Epic Games, Inc. All Rights Reserved.

//-- Server side logic. Serves pixel streaming WebRTC-based page, proxies data back to Streamer --//

var express = require('express');
var app = express();

const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const bodyParser = require('body-parser');
const logging = require('./modules/logging.js');
logging.RegisterConsoleLogger();

// 添加child_process模块用于启动和管理UE程序
const { spawn, exec } = require('child_process');

// Command line argument --configFile needs to be checked before loading the config, all other command line arguments are dealt with through the config object

const defaultConfig = {
	UseFrontend: false,
	UseMatchmaker: false,
	UseHTTPS: false,
	HTTPSCertFile: './certificates/client-cert.pem',
	HTTPSKeyFile: './certificates/client-key.pem',
	UseAuthentication: false,
	LogToFile: true,
	LogVerbose: true,
	HomepageFile: 'player.html',
	AdditionalRoutes: new Map(),
	EnableWebserver: true,
	MatchmakerAddress: "",
	MatchmakerPort: 9999,
	PublicIp: "localhost",
	HttpPort: 80,
	HttpsPort: 443,
	StreamerPort: 8888,
	SFUPort: 8889,
	MaxPlayerCount: -1,
	DisableSSLCert: true,
	UEProgram: null,
	MultiIProgress: true,
	Localhost: false,
	PixelStreamingEncoderCodec: "VP9",
	ResX: 1920,
	ResY: 1080,
	SimulcastParameters: 1
};

const argv = require('yargs').argv;
var configFile = (typeof argv.configFile != 'undefined') ? argv.configFile.toString() : path.join(__dirname, 'config.json');
console.log(`configFile ${configFile}`);
const config = require('./modules/config.js').init(configFile, defaultConfig);

//add das
// 添加playerID到进程ID的映射表
let playerProcessMap = new Map(); // playerId -> process object
let playerStreamerMap = new Map(); // playerId -> streamerId

if (config.LogToFile) {
	logging.RegisterFileLogger('./logs/');
}

console.log("Config: " + JSON.stringify(config, null, '\t'));

var http = require('http').Server(app);

if (config.UseHTTPS) {
	//HTTPS certificate details
	const options = {
		key: fs.readFileSync(path.join(__dirname, config.HTTPSKeyFile)),
		cert: fs.readFileSync(path.join(__dirname, config.HTTPSCertFile))
	};

	var https = require('https').Server(options, app);
}

//If not using authetication then just move on to the next function/middleware
var isAuthenticated = redirectUrl => function (req, res, next) { return next(); }

if (config.UseAuthentication && config.UseHTTPS) {
	var passport = require('passport');
	require('./modules/authentication').init(app);
	// Replace the isAuthenticated with the one setup on passport module
	isAuthenticated = passport.authenticationMiddleware ? passport.authenticationMiddleware : isAuthenticated
} else if (config.UseAuthentication && !config.UseHTTPS) {
	console.error('Trying to use authentication without using HTTPS, this is not allowed and so authentication will NOT be turned on, please turn on HTTPS to turn on authentication');
}

const helmet = require('helmet');
var hsts = require('hsts');
var net = require('net');

var FRONTEND_WEBSERVER = 'https://localhost';
if (config.UseFrontend) {
	var httpPort = 3000;
	var httpsPort = 8000;

	if (config.UseHTTPS && config.DisableSSLCert) {
		//Required for self signed certs otherwise just get an error back when sending request to frontend see https://stackoverflow.com/a/35633993
		console.logColor(logging.Orange, 'WARNING: config.DisableSSLCert is true. Unauthorized SSL certificates will be allowed! This is convenient for local testing but please DO NOT SHIP THIS IN PRODUCTION. To remove this warning please set DisableSSLCert to false in your config.json.');
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
	}

	const httpsClient = require('./modules/httpsClient.js');
	var webRequest = new httpsClient();
} else {
	var httpPort = config.HttpPort;
	var httpsPort = config.HttpsPort;
}

var streamerPort = config.StreamerPort; // port to listen to Streamer connections
var sfuPort = config.SFUPort;
var listenHost = config.Localhost ? '127.0.0.1' : undefined; // 监听地址：true时只监听本地回环，false时监听所有网卡

var matchmakerAddress = '127.0.0.1';
var matchmakerPort = 9999;
var matchmakerRetryInterval = 5;
var matchmakerKeepAliveInterval = 30;
var maxPlayerCount = -1;

var gameSessionId;
var userSessionId;
var serverPublicIp;

// `clientConfig` is send to Streamer and Players
// Example of STUN server setting
// let clientConfig = {peerConnectionOptions: { 'iceServers': [{'urls': ['stun:34.250.222.95:19302']}] }};
var clientConfig = { type: 'config', peerConnectionOptions: {} };

// Parse public server address from command line
// --publicIp <public address>
try {
	if (typeof config.PublicIp != 'undefined') {
		serverPublicIp = config.PublicIp.toString();
	}

	if (typeof config.HttpPort != 'undefined') {
		httpPort = config.HttpPort;
	}

	if (typeof config.HttpsPort != 'undefined') {
		httpsPort = config.HttpsPort;
	}

	if (typeof config.StreamerPort != 'undefined') {
		streamerPort = config.StreamerPort;
	}

	if (typeof config.SFUPort != 'undefined') {
		sfuPort = config.SFUPort;
	}

	if (typeof config.FrontendUrl != 'undefined') {
		FRONTEND_WEBSERVER = config.FrontendUrl;
	}

	if (typeof config.peerConnectionOptions != 'undefined') {
		clientConfig.peerConnectionOptions = JSON.parse(config.peerConnectionOptions);
		console.log(`peerConnectionOptions = ${JSON.stringify(clientConfig.peerConnectionOptions)}`);
	} else {
		console.log("No peerConnectionConfig")
	}

	if (typeof config.MatchmakerAddress != 'undefined') {
		matchmakerAddress = config.MatchmakerAddress;
	}

	if (typeof config.MatchmakerPort != 'undefined') {
		matchmakerPort = config.MatchmakerPort;
	}

	if (typeof config.MatchmakerRetryInterval != 'undefined') {
		matchmakerRetryInterval = config.MatchmakerRetryInterval;
	}

	if (typeof config.MaxPlayerCount != 'undefined') {
		maxPlayerCount = config.MaxPlayerCount;
	}
} catch (e) {
	console.error(e);
	process.exit(2);
}

if (config.UseHTTPS) {
	app.use(helmet());

	app.use(hsts({
		maxAge: 15552000  // 180 days in seconds
	}));

	//Setup http -> https redirect
	console.log('Redirecting http->https');
	app.use(function (req, res, next) {
		if (!req.secure) {
			if (req.get('Host')) {
				var hostAddressParts = req.get('Host').split(':');
				var hostAddress = hostAddressParts[0];
				if (httpsPort != 443) {
					hostAddress = `${hostAddress}:${httpsPort}`;
				}
				return res.redirect(['https://', hostAddress, req.originalUrl].join(''));
			} else {
				console.error(`unable to get host name from header. Requestor ${req.ip}, url path: '${req.originalUrl}', available headers ${JSON.stringify(req.headers)}`);
				return res.status(400).send('Bad Request');
			}
		}
		next();
	});
}

sendGameSessionData();

// set up rate limiter: maximum of five requests per minute
var RateLimit = require('express-rate-limit');
var limiter = RateLimit({
  windowMs: 1*60*1000, // 1 minute
  max: 60
});

// apply rate limiter to all requests
app.use(limiter);

//Setup the login page if we are using authentication
if(config.UseAuthentication){
	if(config.EnableWebserver) {
		app.get('/login', function(req, res){
			res.sendFile(path.join(__dirname, '/Public', '/login.html'));
		});
	}

	// create application/x-www-form-urlencoded parser
	var urlencodedParser = bodyParser.urlencoded({ extended: false })

	//login page form data is posted here
	app.post('/login', 
		urlencodedParser, 
		passport.authenticate('local', { failureRedirect: '/login' }), 
		function(req, res){
			//On success try to redirect to the page that they originally tired to get to, default to '/' if no redirect was found
			var redirectTo = req.session.redirectTo ? req.session.redirectTo : '/';
			delete req.session.redirectTo;
			console.log(`Redirecting to: '${redirectTo}'`);
			res.redirect(redirectTo);
		}
	);
}

if(config.EnableWebserver) {
	//Setup folders
	app.use(express.static(path.join(__dirname, '/Public')))
	app.use('/images', express.static(path.join(__dirname, './images')))
	app.use('/scripts', [isAuthenticated('/login'),express.static(path.join(__dirname, '/scripts'))]);
	app.use('/', [isAuthenticated('/login'), express.static(path.join(__dirname, '/custom_html'))])
}

try {
	for (var property in config.AdditionalRoutes) {
		if (config.AdditionalRoutes.hasOwnProperty(property)) {
			console.log(`Adding additional routes "${property}" -> "${config.AdditionalRoutes[property]}"`)
			app.use(property, [isAuthenticated('/login'), express.static(path.join(__dirname, config.AdditionalRoutes[property]))]);
		}
	}
} catch (err) {
	console.error(`reading config.AdditionalRoutes: ${err}`)
}

if(config.EnableWebserver) {

	// Request has been sent to site root, send the homepage file
	app.get('/', isAuthenticated('/login'), function (req, res) {
		homepageFile = (typeof config.HomepageFile != 'undefined' && config.HomepageFile != '') ? config.HomepageFile.toString() : defaultConfig.HomepageFile;
		
		let pathsToTry = [ path.join(__dirname, homepageFile), path.join(__dirname, '/Public', homepageFile), path.join(__dirname, '/custom_html', homepageFile), homepageFile ];

		// Try a few paths, see if any resolve to a homepage file the user has set
		for(let pathToTry of pathsToTry){
			if(fs.existsSync(pathToTry)){
				// Send the file for browser to display it
				res.sendFile(pathToTry);
				return;
			}
		}

		// Catch file doesn't exist, and send back 404 if not
		console.error('Unable to locate file ' + homepageFile)
		res.status(404).send('Unable to locate file ' + homepageFile);
		return;
	});
}

//Setup http and https servers
http.listen(httpPort, listenHost, function () {
	const hostInfo = listenHost || '*';
	console.logColor(logging.Green, `Http listening on ${hostInfo}: ${httpPort}`);
});

if (config.UseHTTPS) {
	https.listen(httpsPort, listenHost, function () {
		const hostInfo = listenHost || '*';
		console.logColor(logging.Green, `Https listening on ${hostInfo}: ${httpsPort}`);
	});
}

console.logColor(logging.Cyan, `Running Cirrus - The Pixel Streaming reference implementation signalling server for Unreal Engine 5.3.`);

let nextPlayerId = 1;

const StreamerType = { Regular: 0, SFU: 1 };

class Streamer {
	constructor(initialId, ws, type) {
		this.id = initialId;
		this.ws = ws;
		this.type = type;
		this.idCommitted = false;
	}

	// registers this streamers id
	commitId(id) {
		this.id = id;
		this.idCommitted = true;
	}

	// returns true if we have a valid id
	isIdCommitted() {
		return this.idCommitted;
	}

	// links this streamer to a subscribed SFU player (player component of an SFU)
	addSFUPlayer(sfuPlayerId) {
		if (!!this.SFUPlayerId && this.SFUPlayerId != sfuPlayerId) {
			console.error(`Streamer ${this.id} already has an SFU ${this.SFUPlayerId}. Trying to add ${sfuPlayerId} as SFU.`);
			return;
		}
		this.SFUPlayerId = sfuPlayerId;
	}

	// removes the previously subscribed SFU player
	removeSFUPlayer() {
		delete this.SFUPlayerId;
	}

	// gets the player id of the subscribed SFU if any
	getSFUPlayerId() {
		return this.SFUPlayerId;
	}

	// returns true if this streamer is forwarding another streamer
	isSFU() {
		return this.type == StreamerType.SFU;
	}

	// links this streamer to a player, used for SFU connections since they have both components
	setSFUPlayerComponent(playerComponent) {
		if (!this.isSFU()) {
			console.error(`Trying to add an SFU player component ${playerComponent.id} to streamer ${this.id} but it is not an SFU type.`);
			return;
		}
		this.sfuPlayerComponent = playerComponent;
	}

	// gets the player component for this sfu
	getSFUPlayerComponent() {
		if (!this.isSFU()) {
			console.error(`Trying to get an SFU player component from streamer ${this.id} but it is not an SFU type.`);
			return null;
		}
		return this.sfuPlayerComponent;
	}
}

const PlayerType = { Regular: 0, SFU: 1 };
const WhoSendsOffer = { Streamer: 0, Browser: 1 };

class Player {
	constructor(id, ws, type, whoSendsOffer) {
		this.id = id;
		this.ws = ws;
		this.type = type;
		this.whoSendsOffer = whoSendsOffer;
	}

	isSFU() {
		return this.type == PlayerType.SFU;
	}

	subscribe(streamerId) {
		if (!streamers.has(streamerId)) {
			console.error(`subscribe: Player ${this.id} tried to subscribe to a non-existent streamer ${streamerId}`);
			return;
		}
		this.streamerId = streamerId;
		if (this.type == PlayerType.SFU) {
			let streamer = streamers.get(this.streamerId);
			streamer.addSFUPlayer(this.id);
		}
		const msg = { type: 'playerConnected', playerId: this.id, dataChannel: true, sfu: this.type == PlayerType.SFU, sendOffer: this.whoSendsOffer == WhoSendsOffer.Streamer };
		logOutgoing(this.streamerId, msg);
		this.sendFrom(msg);
	}

	unsubscribe() {
		if (this.streamerId && streamers.has(this.streamerId)) {
			if (this.type == PlayerType.SFU) {
				let streamer = streamers.get(this.streamerId);
				if (streamer.getSFUPlayerId() != this.id) {
					console.error(`Trying to unsibscribe SFU player ${this.id} from streamer ${streamer.id} but the current SFUId does not match (${streamer.getSFUPlayerId()}).`)
				} else {
					streamer.removeSFUPlayer();
				}
			}
			const msg = { type: 'playerDisconnected', playerId: this.id };
			logOutgoing(this.streamerId, msg);
			this.sendFrom(msg);
		}
		this.streamerId = null;
	}

	sendFrom(message) {
		if (!this.streamerId) {
			if(streamers.size > 0) {
				this.streamerId = streamers.entries().next().value[0];
				console.logColor(logging.Orange, `Player ${this.id} attempted to send an outgoing message without having subscribed first. Defaulting to ${this.streamerId}`);
			} else {
				console.logColor(logging.Orange, `Player ${this.id} attempted to send an outgoing message without having subscribed first. No streamer connected so this message isn't going anywhere!`)
				return;
			}
		}

		// normally we want to indicate what player this message came from
		// but in some instances we might already have set this (streamerDataChannels) due to poor choices
		if (!message.playerId) {
			message.playerId = this.id;
		}
		const msgString = JSON.stringify(message);

		let streamer = streamers.get(this.streamerId);
		if (!streamer) {
			console.error(`sendFrom: Player ${this.id} subscribed to non-existent streamer: ${this.streamerId}`);
		} else {
			streamer.ws.send(msgString);
		}
	}

	sendTo(message) {
		const msgString = JSON.stringify(message);
		this.ws.send(msgString);
	}

	setSFUStreamerComponent(streamerComponent) {
		if (!this.isSFU()) {
			console.error(`Trying to add an SFU streamer component ${streamerComponent.id} to player ${this.id} but it is not an SFU type.`);
			return;
		}
		this.sfuStreamerComponent = streamerComponent;
	}

	getSFUStreamerComponent() {
		if (!this.isSFU()) {
			console.error(`Trying to get an SFU streamer component from player ${this.id} but it is not an SFU type.`);
			return null;
		}
		return this.sfuStreamerComponent;
	}
};

let streamers = new Map();		// streamerId <-> streamer

let players = new Map(); 		// playerId <-> player/peer/viewer
const LegacyStreamerPrefix = "__LEGACY_STREAMER__"; // old streamers that dont know how to ID will be assigned this id prefix.
const LegacySFUPrefix = "__LEGACY_SFU__"; 					// same as streamer version but for SFUs
const streamerIdTimeoutSecs = 5;

// gets the SFU subscribed to this streamer if any.
function getSFUForStreamer(streamerId) {
	if (!streamers.has(streamerId)) {
		return null;
	}
	const streamer = streamers.get(streamerId);
	const sfuPlayerId = streamer.getSFUPlayerId();
	if (!sfuPlayerId) {
		return null;
	}
	return players.get(sfuPlayerId);
}

function logIncoming(sourceName, msg) {
	if (config.LogVerbose)
		console.logColor(logging.Blue, "\x1b[37m%s ->\x1b[34m %s", sourceName, JSON.stringify(msg));
	else
		console.logColor(logging.Blue, "\x1b[37m%s ->\x1b[34m %s", sourceName, msg.type);
}

function logOutgoing(destName, msg) {
	if (config.LogVerbose)
		console.logColor(logging.Green, "\x1b[37m%s <-\x1b[32m %s", destName, JSON.stringify(msg));
	else
		console.logColor(logging.Green, "\x1b[37m%s <-\x1b[32m %s", destName, msg.type);
}

function logForward(srcName, destName, msg) {
	if (config.LogVerbose)
		console.logColor(logging.Cyan, "\x1b[37m%s -> %s\x1b[36m %s", srcName, destName, JSON.stringify(msg));
	else
		console.logColor(logging.Cyan, "\x1b[37m%s -> %s\x1b[36m %s", srcName, destName, msg.type);
}

let WebSocket = require('ws');

let sfuMessageHandlers = new Map();
let playerMessageHandlers = new Map();

function sanitizePlayerId(playerId) {
	if (playerId && typeof playerId === 'number') {
		playerId = playerId.toString();
	}
	return playerId;
}

function getPlayerIdFromMessage(msg) {
	return sanitizePlayerId(msg.playerId);
}

let uniqueLegacyStreamerPostfix = 0;
function getUniqueLegacyStreamerId() {
	const finalId = LegacyStreamerPrefix + uniqueLegacyStreamerPostfix;
	++uniqueLegacyStreamerPostfix;
	return finalId;
}

let uniqueLegacySFUPostfix = 0;
function getUniqueLegacySFUId() {
	const finalId = LegacySFUPrefix + uniqueLegacySFUPostfix;
	++uniqueLegacySFUPostfix;
	return finalId;
}

function requestStreamerId(streamer) {
	// first we ask the streamer to id itself.
	// if it doesnt reply within a time limit we assume it's an older streamer
	// and assign it an id.

	// request id
	const msg = { type: "identify" };
	logOutgoing(streamer.id, msg);
	streamer.ws.send(JSON.stringify(msg));

	streamer.idTimer = setTimeout(function() {
		// streamer did not respond in time. give it a legacy id.
		const newLegacyId = getUniqueLegacyStreamerId();
		if (newLegacyId.length == 0) {
			const error = `Ran out of legacy ids.`;
			console.error(error);
			streamer.ws.close(1008, error);
		} else {
			registerStreamer(newLegacyId, streamer);
		}

	}, streamerIdTimeoutSecs * 1000);
}

function sanitizeStreamerId(id) {
	let maxPostfix = -1;
	for (let [streamerId, streamer] of streamers) {
		const idMatchRegex = /^(.*?)(\d*)$/;
		const [, baseId, postfix] = streamerId.match(idMatchRegex);
		// if the id is numeric then base id will be empty and we need to compare with the postfix
		if ((baseId != '' && baseId != id) || (baseId == '' && postfix != id)) {
			continue;
		}
		const numPostfix = Number(postfix);
		if (numPostfix > maxPostfix) {
			maxPostfix = numPostfix
		}
	}
	if (maxPostfix >= 0) {
		return id + (maxPostfix + 1);
	}
	return id;
}

function registerStreamer(id, streamer) {
	// Streamer 可能先因识别超时被注册为 Legacy ID，随后才返回真实 ID。
	// 重命名前必须删除同一连接的旧键，并同步已经订阅该连接的 Player。
	const previousIds = [];
	for (const [streamerId, registeredStreamer] of streamers) {
		if (registeredStreamer === streamer) {
			previousIds.push(streamerId);
		}
	}
	for (const previousId of previousIds) {
		streamers.delete(previousId);
	}

	// make sure the id is unique
	const uniqueId = sanitizeStreamerId(id);
	streamer.commitId(uniqueId);
	if (!!streamer.idTimer) {
		clearTimeout(streamer.idTimer);
		delete streamer.idTimer;
	}
	streamers.set(uniqueId, streamer);
	for (const player of players.values()) {
		if (previousIds.includes(player.streamerId)) {
			player.streamerId = uniqueId;
		}
	}
	console.logColor(logging.Green, `Registered new streamer: ${streamer.id}`);
}

function onStreamerDisconnected(streamer) {
	if (streamer.idTimer) {
		clearTimeout(streamer.idTimer);
		delete streamer.idTimer;
	}

	const registeredIds = [];
	for (const [streamerId, registeredStreamer] of streamers) {
		if (registeredStreamer === streamer) {
			registeredIds.push(streamerId);
		}
	}
	if (registeredIds.length === 0) {
		return;
	}

	sendStreamerDisconnectedToMatchmaker();
	for (const streamerId of registeredIds) {
		let sfuPlayer = getSFUForStreamer(streamerId);
		if (sfuPlayer) {
			const msg = { type: "streamerDisconnected" };
			logOutgoing(sfuPlayer.id, msg);
			sfuPlayer.sendTo(msg);
			disconnectAllPlayers(sfuPlayer.id);
		}
		disconnectAllPlayers(streamerId);
		streamers.delete(streamerId);
	}
}

function onStreamerMessageId(streamer, msg) {
	logIncoming(streamer.id, msg);

	let streamerId = msg.id;
	registerStreamer(streamerId, streamer);
}

function onStreamerMessagePing(streamer, msg) {
	logIncoming(streamer.id, msg);

	const pongMsg = JSON.stringify({ type: "pong", time: msg.time});
	streamer.ws.send(pongMsg);
}

function onStreamerMessageDisconnectPlayer(streamer, msg) {
	logIncoming(streamer.id, msg);

	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player) {
		player.ws.close(1011 /* internal error */, msg.reason);
	}
}

function onStreamerMessageLayerPreference(streamer, msg) {
	let sfuPlayer = getSFUForStreamer(streamer.id);
	if (sfuPlayer) {
		logOutgoing(sfuPlayer.id, msg);
		sfuPlayer.sendTo(msg);
	}
}

function forwardStreamerMessageToPlayer(streamer, msg) {
	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player) {
		delete msg.playerId;
		logForward(streamer.id, playerId, msg);
		player.sendTo(msg);
	} else {
		console.warn("No playerId specified, cannot forward message: %s", msg);
	}
}

let streamerMessageHandlers = new Map();
streamerMessageHandlers.set('endpointId', onStreamerMessageId);
streamerMessageHandlers.set('ping', onStreamerMessagePing);
streamerMessageHandlers.set('offer', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('answer', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('iceCandidate', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('disconnectPlayer', onStreamerMessageDisconnectPlayer);
streamerMessageHandlers.set('layerPreference', onStreamerMessageLayerPreference);

console.logColor(logging.Green, `WebSocket listening for Streamer connections on :${streamerPort}`)

//dd jiangs stream 服务器
let streamerServer = new WebSocket.Server({ port: streamerPort, backlog: 1 });
streamerServer.on('connection', function (ws, req) {
	console.logColor(logging.Green, `Streamer connected: ${req.connection.remoteAddress}`);
	sendStreamerConnectedToMatchmaker();

	const temporaryId = req.connection.remoteAddress;
	let streamer = new Streamer(temporaryId, ws, StreamerType.Regular);

	ws.on('message', (msgRaw) => {
		var msg;
		try {
			msg = JSON.parse(msgRaw);
		} catch(err) {
			console.error(`Cannot parse Streamer message: ${msgRaw}\nError: ${err}`);
			ws.close(1008, 'Cannot parse');
			return;
		}

		let handler = streamerMessageHandlers.get(msg.type);
		if (!handler || (typeof handler != 'function')) {
			if (config.LogVerbose) {
				console.logColor(logging.White, "\x1b[37m-> %s\x1b[34m: %s", streamer.id, msgRaw);
			}
			console.error(`unsupported Streamer message type: ${msg.type}`);
			ws.close(1008, 'Unsupported message type');
			return;
		}
		handler(streamer, msg);
	});
	
	ws.on('close', function(code, reason) {
		console.error(`streamer ${streamer.id} disconnected: ${code} - ${reason}`);
		onStreamerDisconnected(streamer);
	});

	ws.on('error', function(error) {
		console.error(`streamer ${streamer.id} connection error: ${error}`);
		onStreamerDisconnected(streamer);
		try {
			ws.close(1006 /* abnormal closure */, error);
		} catch(err) {
			console.error(`ERROR: ws.on error: ${err.message}`);
		}
	});

	ws.send(JSON.stringify(clientConfig));
	requestStreamerId(streamer);
});

function forwardSFUMessageToPlayer(sfuPlayer, msg) {
	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player) {
		logForward(sfuPlayer.getSFUStreamerComponent().id, playerId, msg);
		player.sendTo(msg);
	}
}

function forwardSFUMessageToStreamer(sfuPlayer, msg) {
	logForward(sfuPlayer.getSFUStreamerComponent().id, sfuPlayer.streamerId, msg);
	msg.sfuId = sfuPlayer.id;
	sfuPlayer.sendFrom(msg);
}

function onPeerDataChannelsSFUMessage(sfuPlayer, msg) {
	// sfu is telling a peer what stream id to use for a data channel
	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player) {
		logForward(sfuPlayer.getSFUStreamerComponent().id, playerId, msg);
		player.sendTo(msg);
		player.datachannel = true;
	}
}

// basically a duplicate of the streamer id request but this one does not register the streamer
function requestSFUStreamerId(sfuPlayer) {
	// request id
	const msg = { type: "identify" };
	const sfuStreamerComponent = sfuPlayer.getSFUStreamerComponent();
	logOutgoing(sfuStreamerComponent.id, msg);
	sfuStreamerComponent.ws.send(JSON.stringify(msg));

	sfuStreamerComponent.idTimer = setTimeout(function() {
		// streamer did not respond in time. give it a legacy id.
		const newLegacyId = getUniqueLegacySFUId();
		if (newLegacyId.length == 0) {
			const error = `Ran out of legacy ids.`;
			console.error(error);
			sfuPlayer.ws.close(1008, error);
		} else {
			sfuStreamerComponent.id = newLegacyId;
		}
	}, streamerIdTimeoutSecs * 1000);
}

function onSFUMessageId(sfuPlayer, msg) {
	const sfuStreamerComponent = sfuPlayer.getSFUStreamerComponent();
	logIncoming(sfuStreamerComponent.id, msg);
	sfuStreamerComponent.id = msg.id;

	if (!!sfuStreamerComponent.idTimer) {
		clearTimeout(sfuStreamerComponent.idTimer);
		delete sfuStreamerComponent.idTimer;
	}
}

function onSFUMessageStartStreaming(sfuPlayer, msg) {
	const sfuStreamerComponent = sfuPlayer.getSFUStreamerComponent();
	logIncoming(sfuStreamerComponent.id, msg);
	if (streamers.has(sfuStreamerComponent.id)) {
		console.error(`SFU ${sfuStreamerComponent.id} is already registered as a streamer and streaming.`)
		return;
	}

	registerStreamer(sfuStreamerComponent.id, sfuStreamerComponent);
}

function onSFUMessageStopStreaming(sfuPlayer, msg) {
	const sfuStreamerComponent = sfuPlayer.getSFUStreamerComponent();
	logIncoming(sfuStreamerComponent.id, msg);
if (!streamers.has(sfuStreamerComponent.id)) {
		console.error(`SFU ${sfuStreamerComponent.id} is not registered as a streamer or streaming.`)
		return;
	}

	onStreamerDisconnected(sfuStreamerComponent);
}

function onSFUDisconnected(sfuPlayer) {
	console.log("disconnecting SFU from streamer");
	disconnectAllPlayers(sfuPlayer.id);
	onStreamerDisconnected(sfuPlayer.getSFUStreamerComponent());
	sfuPlayer.unsubscribe();
	sfuPlayer.ws.close(4000, "SFU Disconnected");
	players.delete(sfuPlayer.id);
	streamers.delete(sfuPlayer.id);
}

sfuMessageHandlers.set('listStreamers', onPlayerMessageListStreamers);
sfuMessageHandlers.set('subscribe', onPlayerMessageSubscribe);
sfuMessageHandlers.set('unsubscribe', onPlayerMessageUnsubscribe);
sfuMessageHandlers.set('offer', forwardSFUMessageToPlayer);
sfuMessageHandlers.set('answer', forwardSFUMessageToStreamer);
sfuMessageHandlers.set('streamerDataChannels', forwardSFUMessageToStreamer);
sfuMessageHandlers.set('peerDataChannels', onPeerDataChannelsSFUMessage);
sfuMessageHandlers.set('endpointId', onSFUMessageId);
sfuMessageHandlers.set('startStreaming', onSFUMessageStartStreaming);
sfuMessageHandlers.set('stopStreaming', onSFUMessageStopStreaming);

console.logColor(logging.Green, `WebSocket listening for SFU connections on :${sfuPort}`);
let sfuServer = new WebSocket.Server({ port: sfuPort });
sfuServer.on('connection', function (ws, req) {

	let playerId = sanitizePlayerId(nextPlayerId++);
	console.logColor(logging.Green, `SFU (${req.connection.remoteAddress}) connected `);

	let streamerComponent = new Streamer(req.connection.remoteAddress, ws, StreamerType.SFU);
	let playerComponent = new Player(playerId, ws, PlayerType.SFU, WhoSendsOffer.Streamer);

	streamerComponent.setSFUPlayerComponent(playerComponent);
	playerComponent.setSFUStreamerComponent(streamerComponent);

	players.set(playerId, playerComponent);

	ws.on('message', (msgRaw) => {
		var msg;
		try {
			msg = JSON.parse(msgRaw);
		} catch (err) {
			console.error(`Cannot parse SFU message: ${msgRaw}\nError: ${err}`);
			ws.close(1008, 'Cannot parse');
			return;
		}

		let sfuPlayer = players.get(playerId);
		if (!sfuPlayer) {
			console.error(`Received a message from an SFU not in the player list ${playerId}`);
			ws.close(1001, 'Broken');
			return;
		}

		let handler = sfuMessageHandlers.get(msg.type);
		if (!handler || (typeof handler != 'function')) {
			if (config.LogVerbose) {
				console.logColor(logging.White, "\x1b[37m-> %s\x1b[34m: %s", sfuPlayer.id, msgRaw);
			}
			console.error(`unsupported SFU message type: ${msg.type}`);
			ws.close(1008, 'Unsupported message type');
			return;
		}
		handler(sfuPlayer, msg);
	});

	ws.on('close', function(code, reason) {
		console.error(`SFU disconnected: ${code} - ${reason}`);
		onSFUDisconnected(playerComponent);
	});

	ws.on('error', function(error) {
		console.error(`SFU connection error: ${error}`);
		onSFUDisconnected(playerComponent);
		try {
			ws.close(1006 /* abnormal closure */, error);
		} catch(err) {
			console.error(`ERROR: ws.on error: ${err.message}`);
		}
	});

	requestSFUStreamerId(playerComponent.getSFUStreamerComponent());
});

let playerCount = 0;

function sendPlayersCount() {
	const msg = { type: 'playerCount', count: players.size };
	logOutgoing("[players]", msg);
	for (let player of players.values()) {
		player.sendTo(msg);
	}
}

//dd jiangs palyer 选择steramer
function onPlayerMessageSubscribe(player, msg) {
	logIncoming(player.id, msg);
	const expectedStreamerId = playerStreamerMap.get(player.id);
	if (expectedStreamerId && msg.streamerId !== expectedStreamerId) {
		console.logColor(logging.Orange, `Player ${player.id} attempted to subscribe to ${msg.streamerId}, expected ${expectedStreamerId}`);
		onPlayerMessageListStreamers(player, { type: 'listStreamers' });
		return;
	}
	player.subscribe(msg.streamerId);
}

function onPlayerMessageUnsubscribe(player, msg) {
	logIncoming(player.id, msg);
	player.unsubscribe();
}

function onPlayerMessageStats(player, msg) {
	console.log(`player ${playerId}: stats\n${msg.data}`);
}

//add jiangs palyer获取Stremer列表
function onPlayerMessageListStreamers(player, msg) {
	logIncoming(player.id, msg);

	let reply = { type: 'streamerList', ids: [] };
	const expectedStreamerId = playerStreamerMap.get(player.id);
	if (expectedStreamerId) {
		if (streamers.has(expectedStreamerId)) {
			reply.ids.push(expectedStreamerId);
		}
		logOutgoing(player.id, reply);
		player.sendTo(reply);
		return;
	}

	for (let [streamerId, streamer] of streamers) {
		//add jiangs 已经被使用的Streamer不再返回。单实例模式
		// 检查该streamer是否已被其他玩家使用
		let isUsed = false;
		if (config.MultiIProgress) {
			for (let [pid, p] of players) {
				if (p.streamerId === streamerId && pid !== player.id) {
					isUsed = true;
					break;
				}
			}
		}
		// 只添加未被使用的streamer
		if (!isUsed) {
			reply.ids.push(streamerId);
		}
	}

	logOutgoing(player.id, reply);
	player.sendTo(reply);
}

function forwardPlayerMessage(player, msg) {
	logForward(player.id, player.streamerId, msg);
	player.sendFrom(msg);
}

function getPlayerStreamerId(playerId) {
	return `PlayerStreamer-${playerId}-Session`;
}

// 启动UE程序的函数
function startUEProgram(playerId, streamerId = null) {
	if (!config.UEProgram) {
		console.logColor(logging.Orange, `UEProgram not configured in config.json, skipping program launch for player ${playerId}`);
		return null;
	}

	if (!fs.existsSync(config.UEProgram)) {
		console.logColor(logging.Red, `UEProgram path does not exist: ${config.UEProgram}`);
		return null;
	}

	try {
		// 构建UE程序启动参数
		const ueArgs = [
			'-WINDOWED',
			'-AllowPixelStreamingCommands',
			'-ForceRes',
			`-ResX=${config.ResX}`,
			`-ResY=${config.ResY}`,
			'-PixelStreamingHideCursor',
			'-DisableWindowSizeLimit',
			'-PixelStreamingIP=localhost',
			'-SaveToUserDir',
			`-PixelStreamingPort=${streamerPort}`,
			...(streamerId ? [`-PixelStreamingID=${streamerId}`] : []),
			`-PixelStreamingEncoderCodec=${config.PixelStreamingEncoderCodec || 'VP9'}`,
			`-SimulcastParameters=${config.SimulcastParameters},0,1000000000`,
			'-RenderOffScreen',
			//'-PixelStreamingEncoderMinQP=1',
			//'-PixelStreamingEncoderMaxQP=500000000',
			'-PixelStreamingWebRTCDisableReceiveAudio',
			'-PixelStreamingWebRTCDisableTransmitAudio',
			'-PixelStreamingVPXUseCompute'
		];

		// 打印完整的启动命令
		const fullCommand = `"${config.UEProgram}" ${ueArgs.join(' ')}`;
		console.logColor(logging.Cyan, `=== UE Program Launch Command for Player ${playerId} ===`);
		console.logColor(logging.Cyan, `Command: ${fullCommand}`);
		console.logColor(logging.Cyan, `StreamerPort from config: ${streamerPort}`);
		if (streamerId) {
			console.logColor(logging.Cyan, `Expected Streamer ID: ${streamerId}`);
		}
		console.logColor(logging.Cyan, `================================================`);
		
		console.logColor(logging.Green, `Starting UE program for player ${playerId} with pixel streaming parameters`);
		
		// 启动UE程序
		const ueProcess = spawn(config.UEProgram, ueArgs, {
			detached: false,
			stdio: 'pipe'
		});

		// 记录进程ID映射
		playerProcessMap.set(playerId, ueProcess);

		// 监听进程事件
		ueProcess.on('spawn', () => {
			console.logColor(logging.Green, `UE program started successfully for player ${playerId}, PID: ${ueProcess.pid}`);
			console.logColor(logging.Green, `PixelStreaming configured on port: ${streamerPort}`);
		});

		ueProcess.on('error', (error) => {
			console.logColor(logging.Red, `Failed to start UE program for player ${playerId}: ${error.message}`);
			console.logColor(logging.Red, `Command was: ${fullCommand}`);
			playerProcessMap.delete(playerId);
		});

		ueProcess.on('exit', (code, signal) => {
			console.logColor(logging.Yellow, `UE program for player ${playerId} exited with code ${code}, signal ${signal}`);
			playerProcessMap.delete(playerId);
		});

		// 处理程序输出
		if (ueProcess.stdout) {
			ueProcess.stdout.on('data', (data) => {
				if (config.LogVerbose) {
					console.log(`[UE-${playerId}] ${data.toString().trim()}`);
				}
			});
		}

		if (ueProcess.stderr) {
			ueProcess.stderr.on('data', (data) => {
				console.logColor(logging.Orange, `[UE-${playerId}-ERROR] ${data.toString().trim()}`);
			});
		}

		return ueProcess;
	} catch (error) {
		console.logColor(logging.Red, `Error starting UE program for player ${playerId}: ${error.message}`);
		return null;
	}
}

// 关闭UE程序的函数
function stopUEProgram(playerId) {
	const ueProcess = playerProcessMap.get(playerId);
	if (!ueProcess) {
		console.logColor(logging.Orange, `No UE program found for player ${playerId}`);
		return;
	}
	//ueProcess childProcess
	const childProcess = ueProcess.childProcess;

	try {
		console.logColor(logging.Yellow, `Stopping UE program for player ${playerId}, PID: ${ueProcess.pid}`);
		
		// Windows系统：使用taskkill /F /T强制终止进程树
		if (process.platform === 'win32' && ueProcess.pid) {
			const { exec } = require('child_process');
			
			// 主要方法：使用taskkill /F /T终止进程树
			const killCommand = `taskkill /F /T /PID ${ueProcess.pid}`;
			console.logColor(logging.Cyan, `Executing: ${killCommand}`);
			
			exec(killCommand, (error, stdout, stderr) => {
				if (error) {
					console.logColor(logging.Red, `taskkill /F /T failed for player ${playerId}: ${error.message}`);
					// 如果进程树终止失败，尝试只终止主进程
					const killSingleCommand = `taskkill /F /PID ${ueProcess.pid}`;
					console.logColor(logging.Cyan, `Fallback executing: ${killSingleCommand}`);
					exec(killSingleCommand, (singleError, singleStdout, singleStderr) => {
						if (singleError) {
							console.logColor(logging.Red, `taskkill /F fallback failed for player ${playerId}: ${singleError.message}`);
						} else {
							console.logColor(logging.Green, `taskkill /F fallback successful for player ${playerId}`);
						}
					});
				} else {
					console.logColor(logging.Green, `taskkill /F /T successful for player ${playerId}`);
					if (stdout) console.logColor(logging.Cyan, `Output: ${stdout.trim()}`);
				}
			});
		} else {
			// 非Windows系统：使用SIGKILL
			console.logColor(logging.Yellow, `Non-Windows system, using SIGKILL for player ${playerId}`);
			try {
				ueProcess.kill('SIGKILL');
				console.logColor(logging.Green, `Sent SIGKILL to UE program for player ${playerId}`);
			} catch (killError) {
				console.logColor(logging.Red, `SIGKILL failed for player ${playerId}: ${killError.message}`);
			}
		}
		
		// 延迟清理映射表，给进程时间结束
		setTimeout(() => {
			if (playerProcessMap.has(playerId)) {
				console.logColor(logging.Yellow, `Removing player ${playerId} from process map`);
				playerProcessMap.delete(playerId);
			}
		}, 2000);
		
	} catch (error) {
		console.logColor(logging.Red, `Error stopping UE program for player ${playerId}: ${error.message}`);
		// 强制从映射表中移除
		playerProcessMap.delete(playerId);
	}
}

function onPlayerDisconnected(playerId) {
	const player = players.get(playerId);
	player.unsubscribe();
	players.delete(playerId);
	playerStreamerMap.delete(playerId);
	--playerCount;
	sendPlayersCount();
	sendPlayerDisconnectedToFrontend();
	sendPlayerDisconnectedToMatchmaker();
	
	// 关闭对应的UE程序
	stopUEProgram(playerId);
}

playerMessageHandlers.set('subscribe', onPlayerMessageSubscribe);
playerMessageHandlers.set('unsubscribe', onPlayerMessageUnsubscribe);
playerMessageHandlers.set('stats', onPlayerMessageStats);
playerMessageHandlers.set('offer', forwardPlayerMessage);
playerMessageHandlers.set('answer', forwardPlayerMessage);
playerMessageHandlers.set('iceCandidate', forwardPlayerMessage);
playerMessageHandlers.set('listStreamers', onPlayerMessageListStreamers);
// sfu related messages
playerMessageHandlers.set('dataChannelRequest', forwardPlayerMessage);
playerMessageHandlers.set('peerDataChannelsReady', forwardPlayerMessage);

console.logColor(logging.Green, `WebSocket listening for Players connections on :${httpPort}`);

//dd jiangs 浏览器服务器
let playerServer = new WebSocket.Server({ server: config.UseHTTPS ? https : http });
playerServer.on('connection', function (ws, req) {
	var url = require('url');
	const parsedUrl = url.parse(req.url);
	const urlParams = new URLSearchParams(parsedUrl.search);
	const whoSendsOffer = urlParams.has('OfferToReceive') && urlParams.get('OfferToReceive') !== 'false' ? WhoSendsOffer.Browser : WhoSendsOffer.Streamer;

	if (playerCount + 1 > maxPlayerCount && maxPlayerCount !== -1) {
		console.logColor(logging.Red, `new connection would exceed number of allowed concurrent connections. Max: ${maxPlayerCount}, Current ${playerCount}`);
		ws.close(1013, `too many connections. max: ${maxPlayerCount}, current: ${playerCount}`);
		return;
	}

	++playerCount;
	let playerId = sanitizePlayerId(nextPlayerId++);

	//新的连接
	console.logColor(logging.Green, `player ${playerId} (${req.connection.remoteAddress}) connected`);
	let player = new Player(playerId, ws, PlayerType.Regular, whoSendsOffer);
	players.set(playerId, player);

	// 启动对应的UE程序
	if (!config.MultiIProgress && playerProcessMap.size > 0) {
		console.logColor(logging.Green, `UE program already started for player ${playerId}`);
	} else {
		let expectedStreamerId = null;
		if (config.MultiIProgress && config.UEProgram) {
			expectedStreamerId = getPlayerStreamerId(playerId);
			playerStreamerMap.set(playerId, expectedStreamerId);
		}
		startUEProgram(playerId, expectedStreamerId);
	}

	ws.on('message', (msgRaw) => {
		var msg;
		try {
			msg = JSON.parse(msgRaw);
		} catch (err) {
			console.error(`Cannot parse player ${playerId} message: ${msgRaw}\nError: ${err}`);
			ws.close(1008, 'Cannot parse');
			return;
		}

		let player = players.get(playerId);
		if (!player) {
			console.error(`Received a message from a player not in the player list ${playerId}`);
			ws.close(1001, 'Broken');
			return;
		}

		let handler = playerMessageHandlers.get(msg.type);
		if (!handler || (typeof handler != 'function')) {
			if (config.LogVerbose) {
				console.logColor(logging.White, "\x1b[37m-> %s\x1b[34m: %s", playerId, msgRaw);
			}
			console.error(`unsupported player message type: ${msg.type}`);
			ws.close(1008, 'Unsupported message type');
			return;
		}
		handler(player, msg);
	});

	ws.on('close', function (code, reason) {
		//结束进程
		console.logColor(logging.Yellow, `player ${playerId} connection closed: ${code} - ${reason}`);
		onPlayerDisconnected(playerId);
	});

	ws.on('error', function (error) {
		console.error(`player ${playerId} connection error: ${error}`);
		ws.close(1006 /* abnormal closure */, error);
		onPlayerDisconnected(playerId);

		console.logColor(logging.Red, `Trying to reconnect...`);
		reconnect();
	});

	sendPlayerConnectedToFrontend();
	sendPlayerConnectedToMatchmaker();
	player.ws.send(JSON.stringify(clientConfig));
	sendPlayersCount();
});

function disconnectAllPlayers(streamerId) {
	console.log(`unsubscribing all players on ${streamerId}`);
	let clone = new Map(players);
	for (let player of clone.values()) {
		if (player.streamerId == streamerId) {
			// disconnect players but just unsubscribe the SFU
			const sfuPlayer = getSFUForStreamer(streamerId);
			if (sfuPlayer && player.id == sfuPlayer.id) {
				sfuPlayer.unsubscribe();
			} else {
				player.ws.close();
			}
		}
	}
}

/**
 * Function that handles the connection to the matchmaker.
 */

if (config.UseMatchmaker) {
	var matchmaker = new net.Socket();

	matchmaker.on('connect', function () {
		console.log(`Cirrus connected to Matchmaker ${matchmakerAddress}:${matchmakerPort}`);

		// message.playerConnected is a new variable sent from the SS to help track whether or not a player 
		// is already connected when a 'connect' message is sent (i.e., reconnect). This happens when the MM
		// and the SS get disconnected unexpectedly (was happening often at scale for some reason).
		var playerConnected = false;

		// Set the playerConnected flag to tell the MM if there is already a player active (i.e., don't send a new one here)
		if (players && players.size > 0) {
			playerConnected = true;
		}

		// Add the new playerConnected flag to the message body to the MM
		message = {
			type: 'connect',
			address: typeof serverPublicIp === 'undefined' ? '127.0.0.1' : serverPublicIp,
			https: config.UseHTTPS,
			port: config.UseHTTPS ? httpsPort : httpPort,//修改mathcMaker重定向网页
			ready: streamers.size > 0,
			playerConnected: playerConnected
		};

		matchmaker.write(JSON.stringify(message));
	});

	matchmaker.on('error', (err) => {
		console.log(`Matchmaker connection error ${JSON.stringify(err)}`);
	});

	matchmaker.on('end', () => {
		console.log('Matchmaker connection ended');
	});

	matchmaker.on('close', (hadError) => {
		console.logColor(logging.Blue, 'Setting Keep Alive to true');
		matchmaker.setKeepAlive(true, 60000); // Keeps it alive for 60 seconds

		console.log(`Matchmaker connection closed (hadError=${hadError})`);

		reconnect();
	});

	// Attempt to connect to the Matchmaker
	function connect() {
		matchmaker.connect(matchmakerPort, matchmakerAddress);
	}

	// Try to reconnect to the Matchmaker after a given period of time
	function reconnect() {
		console.log(`Try reconnect to Matchmaker in ${matchmakerRetryInterval} seconds`)
		setTimeout(function () {
			connect();
		}, matchmakerRetryInterval * 1000);
	}

	function registerMMKeepAlive() {
		setInterval(function () {
			message = {
				type: 'ping'
			};
			matchmaker.write(JSON.stringify(message));
		}, matchmakerKeepAliveInterval * 1000);
	}

	connect();
	registerMMKeepAlive();
}

//Keep trying to send gameSessionId in case the server isn't ready yet
function sendGameSessionData() {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	webRequest.get(`${FRONTEND_WEBSERVER}/server/requestSessionId`,
		function (response, body) {
			if (response.statusCode === 200) {
				gameSessionId = body;
				console.log('SessionId: ' + gameSessionId);
			}
			else {
				console.error('Status code: ' + response.statusCode);
				console.error(body);
			}
		},
		function (err) {
			//Repeatedly try in cases where the connection timed out or never connected
			if (err.code === "ECONNRESET") {
				//timeout
				sendGameSessionData();
			} else if (err.code === 'ECONNREFUSED') {
				console.error('Frontend server not running, unable to setup game session');
			} else {
				console.error(err);
			}
		});
}

function sendUserSessionData(serverPort) {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	webRequest.get(`${FRONTEND_WEBSERVER}/server/requestUserSessionId?gameSessionId=${gameSessionId}&serverPort=${serverPort}&appName=${querystring.escape(clientConfig.AppName)}&appDescription=${querystring.escape(clientConfig.AppDescription)}${(typeof serverPublicIp === 'undefined' ? '' : '&serverHost=' + serverPublicIp)}`,
		function (response, body) {
			if (response.statusCode === 410) {
				sendUserSessionData(serverPort);
			} else if (response.statusCode === 200) {
				userSessionId = body;
				console.log('UserSessionId: ' + userSessionId);
			} else {
				console.error('Status code: ' + response.statusCode);
				console.error(body);
			}
		},
		function (err) {
			//Repeatedly try in cases where the connection timed out or never connected
			if (err.code === "ECONNRESET") {
				//timeout
				sendUserSessionData(serverPort);
			} else if (err.code === 'ECONNREFUSED') {
				console.error('Frontend server not running, unable to setup user session');
			} else {
				console.error(err);
			}
		});
}

function sendServerDisconnect() {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	try {
		webRequest.get(`${FRONTEND_WEBSERVER}/server/serverDisconnected?gameSessionId=${gameSessionId}&appName=${querystring.escape(clientConfig.AppName)}`,
			function (response, body) {
				if (response.statusCode === 200) {
					console.log('serverDisconnected acknowledged by Frontend');
				} else {
					console.error('Status code: ' + response.statusCode);
					console.error(body);
				}
			},
			function (err) {
				//Repeatedly try in cases where the connection timed out or never connected
				if (err.code === "ECONNRESET") {
					//timeout
					sendServerDisconnect();
				} else if (err.code === 'ECONNREFUSED') {
					console.error('Frontend server not running, unable to setup user session');
				} else {
					console.error(err);
				}
			});
	} catch (err) {
		console.logColor(logging.Red, `ERROR::: sendServerDisconnect error: ${err.message}`);
	}
}

function sendPlayerConnectedToFrontend() {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	try {
		webRequest.get(`${FRONTEND_WEBSERVER}/server/clientConnected?gameSessionId=${gameSessionId}&appName=${querystring.escape(clientConfig.AppName)}`,
			function (response, body) {
				if (response.statusCode === 200) {
					console.log('clientConnected acknowledged by Frontend');
				} else {
					console.error('Status code: ' + response.statusCode);
					console.error(body);
				}
			},
			function (err) {
				//Repeatedly try in cases where the connection timed out or never connected
				if (err.code === "ECONNRESET") {
					//timeout
					sendPlayerConnectedToFrontend();
				} else if (err.code === 'ECONNREFUSED') {
					console.error('Frontend server not running, unable to setup game session');
				} else {
					console.error(err);
				}
			});
	} catch (err) {
		console.logColor(logging.Red, `ERROR::: sendPlayerConnectedToFrontend error: ${err.message}`);
	}
}

function sendPlayerDisconnectedToFrontend() {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	try {
		webRequest.get(`${FRONTEND_WEBSERVER}/server/clientDisconnected?gameSessionId=${gameSessionId}&appName=${querystring.escape(clientConfig.AppName)}`,
			function (response, body) {
				if (response.statusCode === 200) {
					console.log('clientDisconnected acknowledged by Frontend');
				}
				else {
					console.error('Status code: ' + response.statusCode);
					console.error(body);
				}
			},
			function (err) {
				//Repeatedly try in cases where the connection timed out or never connected
				if (err.code === "ECONNRESET") {
					//timeout
					sendPlayerDisconnectedToFrontend();
				} else if (err.code === 'ECONNREFUSED') {
					console.error('Frontend server not running, unable to setup game session');
				} else {
					console.error(err);
				}
			});
	} catch (err) {
		console.logColor(logging.Red, `ERROR::: sendPlayerDisconnectedToFrontend error: ${err.message}`);
	}
}

function sendStreamerConnectedToMatchmaker() {
	if (!config.UseMatchmaker)
		return;
	try {
		message = {
			type: 'streamerConnected'
		};
		matchmaker.write(JSON.stringify(message));
	} catch (err) {
		console.logColor(logging.Red, `ERROR sending streamerConnected: ${err.message}`);
	}
}

function sendStreamerDisconnectedToMatchmaker() {
	if (!config.UseMatchmaker)
		return;
	try {
		message = {
			type: 'streamerDisconnected'
		};
		matchmaker.write(JSON.stringify(message));	
	} catch (err) {
		console.logColor(logging.Red, `ERROR sending streamerDisconnected: ${err.message}`);
	}
}

// The Matchmaker will not re-direct clients to this Cirrus server if any client
// is connected.
function sendPlayerConnectedToMatchmaker() {
	if (!config.UseMatchmaker)
		return;
	try {
		message = {
			type: 'clientConnected'
		};
		matchmaker.write(JSON.stringify(message));
	} catch (err) {
		console.logColor(logging.Red, `ERROR sending clientConnected: ${err.message}`);
	}
}

// The Matchmaker is interested when nobody is connected to a Cirrus server
// because then it can re-direct clients to this re-cycled Cirrus server.
function sendPlayerDisconnectedToMatchmaker() {
	if (!config.UseMatchmaker)
		return;
	try {
		message = {
			type: 'clientDisconnected'
		};
		matchmaker.write(JSON.stringify(message));
	} catch (err) {
		console.logColor(logging.Red, `ERROR sending clientDisconnected: ${err.message}`);
	}
}

// 同步清理，用于 exit 事件（exit 事件不支持异步操作）
function cleanupAllUEProgramsSync() {
	const { execSync } = require('child_process');
	for (let [playerId, ueProcess] of playerProcessMap) {
		if (process.platform === 'win32' && ueProcess.pid) {
			try {
				execSync(`taskkill /F /T /PID ${ueProcess.pid}`);
			} catch (e) {
				try { execSync(`taskkill /F /PID ${ueProcess.pid}`); } catch (_) {}
			}
		} else {
			try { ueProcess.kill('SIGKILL'); } catch (_) {}
		}
	}
	playerProcessMap.clear();
}

// 清理所有UE程序的函数
function cleanupAllUEPrograms() {
	console.logColor(logging.Yellow, 'Cleaning up all UE programs...');
	const promises = [];

	for (let [playerId, ueProcess] of playerProcessMap) {
		try {
			console.logColor(logging.Yellow, `Stopping UE program for player ${playerId}, PID: ${ueProcess.pid}`);

			// Windows系统：使用taskkill /F /T强制终止进程树
			if (process.platform === 'win32' && ueProcess.pid) {
				const { exec } = require('child_process');
				const killCommand = `taskkill /F /T /PID ${ueProcess.pid}`;
				console.logColor(logging.Cyan, `Executing cleanup: ${killCommand}`);

				const promise = new Promise((resolve) => {
					exec(killCommand, (error, stdout, stderr) => {
						if (error) {
							console.logColor(logging.Red, `Cleanup taskkill /F /T failed for player ${playerId}: ${error.message}`);
							// 尝试单个进程终止
							exec(`taskkill /F /PID ${ueProcess.pid}`, (singleError, singleStdout, singleStderr) => {
								if (!singleError) {
									console.logColor(logging.Green, `Cleanup fallback successful for player ${playerId}`);
								}
								resolve();
							});
						} else {
							console.logColor(logging.Green, `Cleanup taskkill /F /T successful for player ${playerId}`);
							resolve();
						}
					});
				});
				promises.push(promise);
			} else {
				// 非Windows系统：使用SIGKILL
				try {
					ueProcess.kill('SIGKILL');
					console.logColor(logging.Green, `Cleanup SIGKILL sent for player ${playerId}`);
				} catch (killError) {
					console.logColor(logging.Red, `Cleanup SIGKILL failed for player ${playerId}: ${killError.message}`);
				}
			}

		} catch (error) {
			console.logColor(logging.Red, `Error during cleanup for player ${playerId}: ${error.message}`);
		}
	}

	// 等待所有终止命令完成后清理映射表
	Promise.allSettled(promises).then(() => {
		playerProcessMap.clear();
		console.logColor(logging.Green, 'All UE programs cleanup completed');
	});
}

// 处理服务器关闭信号
process.on('SIGTERM', () => {
	console.logColor(logging.Yellow, 'Received SIGTERM, shutting down gracefully...');
	cleanupAllUEPrograms();
	process.exit(0);
});

process.on('SIGINT', () => {
	console.logColor(logging.Yellow, 'Received SIGINT, shutting down gracefully...');
	cleanupAllUEPrograms();
	process.exit(0);
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
	console.logColor(logging.Red, `Uncaught Exception: ${error.message}`);
	console.error(error.stack);
	cleanupAllUEPrograms();
	process.exit(1);
});

// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
	console.logColor(logging.Red, `Unhandled Rejection at: ${promise}, reason: ${reason}`);
	cleanupAllUEPrograms();
	process.exit(1);
});

console.logColor(logging.Green, 'SignallingWebServer started with UE program management enabled');
console.logColor(logging.Cyan, `UE Program path: ${config.UEProgram || 'Not configured'}`);

if (process.platform === 'win32') {
  process.on('SIGHUP', () => {
    console.logColor(logging.Yellow, 'Received SIGHUP, shutting down gracefully...');
    cleanupAllUEPrograms();
    process.exit(0);
  });
  // 控制台窗口关闭（点击 X）触发 SIGBREAK
  process.on('SIGBREAK', () => {
    console.logColor(logging.Yellow, 'Received SIGBREAK (console closed), shutting down...');
    cleanupAllUEPrograms();
    process.exit(0);
  });
}

process.on('beforeExit', (code) => {
  cleanupAllUEPrograms();
});

process.on('exit', (code) => {
  cleanupAllUEProgramsSync();
});
