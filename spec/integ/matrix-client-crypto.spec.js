"use strict";
var sdk = require("../..");
var q = require("q");
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");
function MockStorageApi() {
    this.data = {};
}
MockStorageApi.prototype = {
    setItem: function(k, v) {
        this.data[k] = v;
    },
    getItem: function(k) {
        return this.data[k] || null;
    },
    removeItem: function(k) {
        delete this.data[k];
    }
};

describe("MatrixClient crypto", function() {
    if (!sdk.CRYPTO_ENABLED) {
        return;
    }

    var baseUrl = "http://localhost.or.something";
    var httpBackend;
    var aliClient;
    var roomId = "!room:localhost";
    var aliUserId = "@ali:localhost";
    var aliDeviceId = "zxcvb";
    var aliAccessToken = "aseukfgwef";
    var bobClient;
    var bobUserId = "@bob:localhost";
    var bobDeviceId = "bvcxz";
    var bobAccessToken = "fewgfkuesa";
    var bobOneTimeKeys;
    var bobDeviceKeys;
    var bobDeviceCurve25519Key;
    var bobDeviceEd25519Key;
    var aliLocalStore;
    var aliStorage;
    var bobStorage;
    var aliMessage;

    beforeEach(function() {
        aliLocalStore = new MockStorageApi();
        aliStorage = new sdk.WebStorageSessionStore(aliLocalStore);
        bobStorage = new sdk.WebStorageSessionStore(new MockStorageApi());
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);

        aliClient = sdk.createClient({
            baseUrl: baseUrl,
            userId: aliUserId,
            accessToken: aliAccessToken,
            deviceId: aliDeviceId,
            sessionStore: aliStorage
        });

        bobClient = sdk.createClient({
            baseUrl: baseUrl,
            userId: bobUserId,
            accessToken: bobAccessToken,
            deviceId: bobDeviceId,
            sessionStore: bobStorage
        });

        httpBackend.when("GET", "/pushrules").respond(200, {});
        httpBackend.when("POST", "/filter").respond(200, { filter_id: "fid" });
    });

    describe("Ali account setup", function() {
        it("should have device keys", function(done) {
            expect(aliClient.deviceKeys).toBeDefined();
            expect(aliClient.deviceKeys.user_id).toEqual(aliUserId);
            expect(aliClient.deviceKeys.device_id).toEqual(aliDeviceId);
            done();
        });
        it("should have a curve25519 key", function(done) {
            expect(aliClient.deviceCurve25519Key).toBeDefined();
            done();
        });
    });

    function bobUploadsKeys() {
        var uploadPath = "/keys/upload/bvcxz";
        httpBackend.when("POST", uploadPath).respond(200, function(path, content) {
            expect(content.one_time_keys).toEqual({});
            httpBackend.when("POST", uploadPath).respond(200, function(path, content) {
                expect(content.one_time_keys).not.toEqual({});
                bobDeviceKeys = content.device_keys;
                bobOneTimeKeys = content.one_time_keys;
                var count = 0;
                for (var key in content.one_time_keys) {
                    if (content.one_time_keys.hasOwnProperty(key)) {
                        count++;
                    }
                }
                expect(count).toEqual(5);
                return {one_time_key_counts: {curve25519: count}};
            });
            return {one_time_key_counts: {}};
        });
        bobClient.uploadKeys(5);
        return httpBackend.flush().then(function() {
            expect(bobDeviceKeys).toBeDefined();
            expect(bobOneTimeKeys).toBeDefined();
            bobDeviceCurve25519Key = bobDeviceKeys.keys["curve25519:bvcxz"];
            bobDeviceEd25519Key = bobDeviceKeys.keys["ed25519:bvcxz"];
        });
    }

    it("Bob uploads without one-time keys and with one-time keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .catch(utils.failTest).done(done);
    });

    function aliDownloadsKeys() {
        var bobKeys = {};
        bobKeys[bobDeviceId] = bobDeviceKeys;
        httpBackend.when("POST", "/keys/query").respond(200, function(path, content) {
            expect(content.device_keys[bobUserId]).toEqual({});
            var result = {};
            result[bobUserId] = bobKeys;
            return {device_keys: result};
        });
        aliClient.downloadKeys([bobUserId]).then(function() {
            expect(aliClient.listDeviceKeys(bobUserId)).toEqual([{
                id: "bvcxz",
                key: bobDeviceEd25519Key
            }]);
        });
        return httpBackend.flush().then(function() {
            var devices = aliStorage.getEndToEndDevicesForUser(bobUserId);
            expect(devices).toEqual(bobKeys);
        });
    }

    it("Ali downloads Bobs keys", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .catch(utils.failTest).done(done);
    });

    function aliEnablesEncryption() {
        httpBackend.when("POST", "/keys/claim").respond(200, function(path, content) {
            expect(content.one_time_keys[bobUserId][bobDeviceId]).toEqual("curve25519");
            for (var keyId in bobOneTimeKeys) {
                if (bobOneTimeKeys.hasOwnProperty(keyId)) {
                    if (keyId.indexOf("curve25519:") === 0) {
                        break;
                    }
                }
            }
            var result = {};
            result[bobUserId] = {};
            result[bobUserId][bobDeviceId] = {};
            result[bobUserId][bobDeviceId][keyId] = bobOneTimeKeys[keyId];
            return {one_time_keys: result};
        });
        var p = aliClient.setRoomEncryption(roomId, {
            algorithm: "m.olm.v1.curve25519-aes-sha2",
            members: [aliUserId, bobUserId]
        }).then(function(res) {
            expect(res.missingUsers).toEqual([]);
            expect(res.missingDevices).toEqual({});
            expect(aliClient.isRoomEncrypted(roomId)).toBeTruthy();
        });
        httpBackend.flush();
        return p;
    }

    it("Ali enables encryption", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .then(aliEnablesEncryption)
            .catch(utils.failTest).done(done);
    });

    function aliSendsMessage() {
        var txnId = "a.transaction.id";
        var path = "/send/m.room.encrypted/" + txnId;
        httpBackend.when("PUT", path).respond(200, function(path, content) {
            aliMessage = content;
            expect(aliMessage.ciphertext[bobDeviceCurve25519Key]).toBeDefined();
            return {};
        });
        aliClient.sendMessage(
            roomId, {msgtype: "m.text", body: "Hello, World"}, txnId
        );
        return httpBackend.flush();
    }

    it("Ali sends a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .catch(utils.failTest).done(done);
    });

    function bobRecvMessage() {
        var syncData = {
            next_batch: "x",
            rooms: {
                join: {

                }
            }
        };
        syncData.rooms.join[roomId] = {
            timeline: {
                events: [
                    utils.mkEvent({
                        type: "m.room.encrypted",
                        room: roomId,
                        content: aliMessage
                    })
                ]
            }
        };
        httpBackend.when("GET", "/sync").respond(200, syncData);
        var deferred = q.defer();
        bobClient.on("event", function(event) {
            expect(event.getType()).toEqual("m.room.message");
            expect(event.getContent()).toEqual({
                msgtype: "m.text",
                body: "Hello, World"
            });
            expect(event.isEncrypted()).toBeTruthy();
            deferred.resolve();
        });
        bobClient.startClient();
        httpBackend.flush();
        return deferred.promise;
    }

    it("Bob receives a message", function(done) {
        q()
            .then(bobUploadsKeys)
            .then(aliDownloadsKeys)
            .then(aliEnablesEncryption)
            .then(aliSendsMessage)
            .then(bobRecvMessage)
            .catch(utils.failTest).done(done);
    });
});
