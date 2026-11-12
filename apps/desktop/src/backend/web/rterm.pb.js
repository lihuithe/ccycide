/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-mixed-operators, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars, default-case, jsdoc/require-param*/
import $protobuf from "protobufjs/minimal.js";

const $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;
const $Object = $util.global.Object, $undefined = $util.global.undefined, $Error = $util.global.Error, $RangeError = $util.global.RangeError, $TypeError = $util.global.TypeError, $Number = $util.global.Number, $String = $util.global.String, $Array = $util.global.Array, $Boolean = $util.global.Boolean, $parseInt = $util.global.parseInt, $BigInt = $util.global.BigInt, $isFinite = $util.global.isFinite;

const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

export const rterm = $root.rterm = (() => {

    const rterm = {};

    rterm.v1 = (function() {

        const v1 = {};

        v1.Frame = (function() {

            const Frame = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            Frame.prototype.channel = 0;
            Frame.prototype.hello = null;
            Frame.prototype.helloAck = null;
            Frame.prototype.ping = null;
            Frame.prototype.pong = null;
            Frame.prototype.error = null;
            Frame.prototype.bye = null;
            Frame.prototype.termOpen = null;
            Frame.prototype.termOpened = null;
            Frame.prototype.termList = null;
            Frame.prototype.termListResp = null;
            Frame.prototype.termAttach = null;
            Frame.prototype.termClose = null;
            Frame.prototype.termOutput = null;
            Frame.prototype.termInput = null;
            Frame.prototype.termSubmit = null;
            Frame.prototype.termResize = null;
            Frame.prototype.termAck = null;
            Frame.prototype.termState = null;
            Frame.prototype.termExit = null;
            Frame.prototype.fileBegin = null;
            Frame.prototype.fileAccept = null;
            Frame.prototype.fileChunk = null;
            Frame.prototype.fileAck = null;
            Frame.prototype.fileEnd = null;
            Frame.prototype.fileDone = null;
            Frame.prototype.fileCancel = null;
            Frame.prototype.actionCatalog = null;
            Frame.prototype.termAction = null;
            Frame.prototype.termActionResult = null;
            Frame.prototype.appState = null;
            Frame.prototype.appNotice = null;
            Frame.prototype.commandList = null;
            Frame.prototype.commandListReq = null;

            let $oneOfFields;

            $Object.defineProperty(Frame.prototype, "body", {
                get: $util.oneOfGetter($oneOfFields = ["hello", "helloAck", "ping", "pong", "error", "bye", "termOpen", "termOpened", "termList", "termListResp", "termAttach", "termClose", "termOutput", "termInput", "termSubmit", "termResize", "termAck", "termState", "termExit", "fileBegin", "fileAccept", "fileChunk", "fileAck", "fileEnd", "fileDone", "fileCancel", "actionCatalog", "termAction", "termActionResult", "appState", "appNotice", "commandList", "commandListReq"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            Frame.create = function(properties) {
                return new Frame(properties);
            };

            Frame.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.channel != null && $Object.hasOwnProperty.call(m, "channel") && m.channel !== 0)
                    w.uint32(8).uint32(m.channel);
                if (m.hello != null && $Object.hasOwnProperty.call(m, "hello"))
                    $root.rterm.v1.Hello.encode(m.hello, w.uint32(82).fork(), q + 1).ldelim();
                if (m.helloAck != null && $Object.hasOwnProperty.call(m, "helloAck"))
                    $root.rterm.v1.HelloAck.encode(m.helloAck, w.uint32(90).fork(), q + 1).ldelim();
                if (m.ping != null && $Object.hasOwnProperty.call(m, "ping"))
                    $root.rterm.v1.Ping.encode(m.ping, w.uint32(98).fork(), q + 1).ldelim();
                if (m.pong != null && $Object.hasOwnProperty.call(m, "pong"))
                    $root.rterm.v1.Pong.encode(m.pong, w.uint32(106).fork(), q + 1).ldelim();
                if (m.error != null && $Object.hasOwnProperty.call(m, "error"))
                    $root.rterm.v1.Error.encode(m.error, w.uint32(114).fork(), q + 1).ldelim();
                if (m.bye != null && $Object.hasOwnProperty.call(m, "bye"))
                    $root.rterm.v1.Bye.encode(m.bye, w.uint32(122).fork(), q + 1).ldelim();
                if (m.termOpen != null && $Object.hasOwnProperty.call(m, "termOpen"))
                    $root.rterm.v1.TermOpen.encode(m.termOpen, w.uint32(162).fork(), q + 1).ldelim();
                if (m.termOpened != null && $Object.hasOwnProperty.call(m, "termOpened"))
                    $root.rterm.v1.TermOpened.encode(m.termOpened, w.uint32(170).fork(), q + 1).ldelim();
                if (m.termList != null && $Object.hasOwnProperty.call(m, "termList"))
                    $root.rterm.v1.TermList.encode(m.termList, w.uint32(178).fork(), q + 1).ldelim();
                if (m.termListResp != null && $Object.hasOwnProperty.call(m, "termListResp"))
                    $root.rterm.v1.TermListResp.encode(m.termListResp, w.uint32(186).fork(), q + 1).ldelim();
                if (m.termAttach != null && $Object.hasOwnProperty.call(m, "termAttach"))
                    $root.rterm.v1.TermAttach.encode(m.termAttach, w.uint32(194).fork(), q + 1).ldelim();
                if (m.termClose != null && $Object.hasOwnProperty.call(m, "termClose"))
                    $root.rterm.v1.TermClose.encode(m.termClose, w.uint32(202).fork(), q + 1).ldelim();
                if (m.termOutput != null && $Object.hasOwnProperty.call(m, "termOutput"))
                    $root.rterm.v1.TermOutput.encode(m.termOutput, w.uint32(242).fork(), q + 1).ldelim();
                if (m.termInput != null && $Object.hasOwnProperty.call(m, "termInput"))
                    $root.rterm.v1.TermInput.encode(m.termInput, w.uint32(250).fork(), q + 1).ldelim();
                if (m.termSubmit != null && $Object.hasOwnProperty.call(m, "termSubmit"))
                    $root.rterm.v1.TermSubmit.encode(m.termSubmit, w.uint32(258).fork(), q + 1).ldelim();
                if (m.termResize != null && $Object.hasOwnProperty.call(m, "termResize"))
                    $root.rterm.v1.TermResize.encode(m.termResize, w.uint32(266).fork(), q + 1).ldelim();
                if (m.termAck != null && $Object.hasOwnProperty.call(m, "termAck"))
                    $root.rterm.v1.TermAck.encode(m.termAck, w.uint32(274).fork(), q + 1).ldelim();
                if (m.termState != null && $Object.hasOwnProperty.call(m, "termState"))
                    $root.rterm.v1.TermState.encode(m.termState, w.uint32(282).fork(), q + 1).ldelim();
                if (m.termExit != null && $Object.hasOwnProperty.call(m, "termExit"))
                    $root.rterm.v1.TermExit.encode(m.termExit, w.uint32(290).fork(), q + 1).ldelim();
                if (m.fileBegin != null && $Object.hasOwnProperty.call(m, "fileBegin"))
                    $root.rterm.v1.FileBegin.encode(m.fileBegin, w.uint32(322).fork(), q + 1).ldelim();
                if (m.fileAccept != null && $Object.hasOwnProperty.call(m, "fileAccept"))
                    $root.rterm.v1.FileAccept.encode(m.fileAccept, w.uint32(330).fork(), q + 1).ldelim();
                if (m.fileChunk != null && $Object.hasOwnProperty.call(m, "fileChunk"))
                    $root.rterm.v1.FileChunk.encode(m.fileChunk, w.uint32(338).fork(), q + 1).ldelim();
                if (m.fileAck != null && $Object.hasOwnProperty.call(m, "fileAck"))
                    $root.rterm.v1.FileAck.encode(m.fileAck, w.uint32(346).fork(), q + 1).ldelim();
                if (m.fileEnd != null && $Object.hasOwnProperty.call(m, "fileEnd"))
                    $root.rterm.v1.FileEnd.encode(m.fileEnd, w.uint32(354).fork(), q + 1).ldelim();
                if (m.fileDone != null && $Object.hasOwnProperty.call(m, "fileDone"))
                    $root.rterm.v1.FileDone.encode(m.fileDone, w.uint32(362).fork(), q + 1).ldelim();
                if (m.fileCancel != null && $Object.hasOwnProperty.call(m, "fileCancel"))
                    $root.rterm.v1.FileCancel.encode(m.fileCancel, w.uint32(370).fork(), q + 1).ldelim();
                if (m.actionCatalog != null && $Object.hasOwnProperty.call(m, "actionCatalog"))
                    $root.rterm.v1.ActionCatalog.encode(m.actionCatalog, w.uint32(402).fork(), q + 1).ldelim();
                if (m.termAction != null && $Object.hasOwnProperty.call(m, "termAction"))
                    $root.rterm.v1.TermAction.encode(m.termAction, w.uint32(410).fork(), q + 1).ldelim();
                if (m.termActionResult != null && $Object.hasOwnProperty.call(m, "termActionResult"))
                    $root.rterm.v1.TermActionResult.encode(m.termActionResult, w.uint32(418).fork(), q + 1).ldelim();
                if (m.appState != null && $Object.hasOwnProperty.call(m, "appState"))
                    $root.rterm.v1.AppState.encode(m.appState, w.uint32(426).fork(), q + 1).ldelim();
                if (m.appNotice != null && $Object.hasOwnProperty.call(m, "appNotice"))
                    $root.rterm.v1.AppNotice.encode(m.appNotice, w.uint32(434).fork(), q + 1).ldelim();
                if (m.commandList != null && $Object.hasOwnProperty.call(m, "commandList"))
                    $root.rterm.v1.CommandList.encode(m.commandList, w.uint32(442).fork(), q + 1).ldelim();
                if (m.commandListReq != null && $Object.hasOwnProperty.call(m, "commandListReq"))
                    $root.rterm.v1.CommandListReq.encode(m.commandListReq, w.uint32(450).fork(), q + 1).ldelim();
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            Frame.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.Frame();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.channel = v;
                            else
                                delete m.channel;
                            continue;
                        }
                    case 10: {
                            if (u !== 2)
                                break;
                            m.hello = $root.rterm.v1.Hello.decode(r, r.size(), $undefined, q + 1, m.hello);
                            m.body = "hello";
                            continue;
                        }
                    case 11: {
                            if (u !== 2)
                                break;
                            m.helloAck = $root.rterm.v1.HelloAck.decode(r, r.size(), $undefined, q + 1, m.helloAck);
                            m.body = "helloAck";
                            continue;
                        }
                    case 12: {
                            if (u !== 2)
                                break;
                            m.ping = $root.rterm.v1.Ping.decode(r, r.size(), $undefined, q + 1, m.ping);
                            m.body = "ping";
                            continue;
                        }
                    case 13: {
                            if (u !== 2)
                                break;
                            m.pong = $root.rterm.v1.Pong.decode(r, r.size(), $undefined, q + 1, m.pong);
                            m.body = "pong";
                            continue;
                        }
                    case 14: {
                            if (u !== 2)
                                break;
                            m.error = $root.rterm.v1.Error.decode(r, r.size(), $undefined, q + 1, m.error);
                            m.body = "error";
                            continue;
                        }
                    case 15: {
                            if (u !== 2)
                                break;
                            m.bye = $root.rterm.v1.Bye.decode(r, r.size(), $undefined, q + 1, m.bye);
                            m.body = "bye";
                            continue;
                        }
                    case 20: {
                            if (u !== 2)
                                break;
                            m.termOpen = $root.rterm.v1.TermOpen.decode(r, r.size(), $undefined, q + 1, m.termOpen);
                            m.body = "termOpen";
                            continue;
                        }
                    case 21: {
                            if (u !== 2)
                                break;
                            m.termOpened = $root.rterm.v1.TermOpened.decode(r, r.size(), $undefined, q + 1, m.termOpened);
                            m.body = "termOpened";
                            continue;
                        }
                    case 22: {
                            if (u !== 2)
                                break;
                            m.termList = $root.rterm.v1.TermList.decode(r, r.size(), $undefined, q + 1, m.termList);
                            m.body = "termList";
                            continue;
                        }
                    case 23: {
                            if (u !== 2)
                                break;
                            m.termListResp = $root.rterm.v1.TermListResp.decode(r, r.size(), $undefined, q + 1, m.termListResp);
                            m.body = "termListResp";
                            continue;
                        }
                    case 24: {
                            if (u !== 2)
                                break;
                            m.termAttach = $root.rterm.v1.TermAttach.decode(r, r.size(), $undefined, q + 1, m.termAttach);
                            m.body = "termAttach";
                            continue;
                        }
                    case 25: {
                            if (u !== 2)
                                break;
                            m.termClose = $root.rterm.v1.TermClose.decode(r, r.size(), $undefined, q + 1, m.termClose);
                            m.body = "termClose";
                            continue;
                        }
                    case 30: {
                            if (u !== 2)
                                break;
                            m.termOutput = $root.rterm.v1.TermOutput.decode(r, r.size(), $undefined, q + 1, m.termOutput);
                            m.body = "termOutput";
                            continue;
                        }
                    case 31: {
                            if (u !== 2)
                                break;
                            m.termInput = $root.rterm.v1.TermInput.decode(r, r.size(), $undefined, q + 1, m.termInput);
                            m.body = "termInput";
                            continue;
                        }
                    case 32: {
                            if (u !== 2)
                                break;
                            m.termSubmit = $root.rterm.v1.TermSubmit.decode(r, r.size(), $undefined, q + 1, m.termSubmit);
                            m.body = "termSubmit";
                            continue;
                        }
                    case 33: {
                            if (u !== 2)
                                break;
                            m.termResize = $root.rterm.v1.TermResize.decode(r, r.size(), $undefined, q + 1, m.termResize);
                            m.body = "termResize";
                            continue;
                        }
                    case 34: {
                            if (u !== 2)
                                break;
                            m.termAck = $root.rterm.v1.TermAck.decode(r, r.size(), $undefined, q + 1, m.termAck);
                            m.body = "termAck";
                            continue;
                        }
                    case 35: {
                            if (u !== 2)
                                break;
                            m.termState = $root.rterm.v1.TermState.decode(r, r.size(), $undefined, q + 1, m.termState);
                            m.body = "termState";
                            continue;
                        }
                    case 36: {
                            if (u !== 2)
                                break;
                            m.termExit = $root.rterm.v1.TermExit.decode(r, r.size(), $undefined, q + 1, m.termExit);
                            m.body = "termExit";
                            continue;
                        }
                    case 40: {
                            if (u !== 2)
                                break;
                            m.fileBegin = $root.rterm.v1.FileBegin.decode(r, r.size(), $undefined, q + 1, m.fileBegin);
                            m.body = "fileBegin";
                            continue;
                        }
                    case 41: {
                            if (u !== 2)
                                break;
                            m.fileAccept = $root.rterm.v1.FileAccept.decode(r, r.size(), $undefined, q + 1, m.fileAccept);
                            m.body = "fileAccept";
                            continue;
                        }
                    case 42: {
                            if (u !== 2)
                                break;
                            m.fileChunk = $root.rterm.v1.FileChunk.decode(r, r.size(), $undefined, q + 1, m.fileChunk);
                            m.body = "fileChunk";
                            continue;
                        }
                    case 43: {
                            if (u !== 2)
                                break;
                            m.fileAck = $root.rterm.v1.FileAck.decode(r, r.size(), $undefined, q + 1, m.fileAck);
                            m.body = "fileAck";
                            continue;
                        }
                    case 44: {
                            if (u !== 2)
                                break;
                            m.fileEnd = $root.rterm.v1.FileEnd.decode(r, r.size(), $undefined, q + 1, m.fileEnd);
                            m.body = "fileEnd";
                            continue;
                        }
                    case 45: {
                            if (u !== 2)
                                break;
                            m.fileDone = $root.rterm.v1.FileDone.decode(r, r.size(), $undefined, q + 1, m.fileDone);
                            m.body = "fileDone";
                            continue;
                        }
                    case 46: {
                            if (u !== 2)
                                break;
                            m.fileCancel = $root.rterm.v1.FileCancel.decode(r, r.size(), $undefined, q + 1, m.fileCancel);
                            m.body = "fileCancel";
                            continue;
                        }
                    case 50: {
                            if (u !== 2)
                                break;
                            m.actionCatalog = $root.rterm.v1.ActionCatalog.decode(r, r.size(), $undefined, q + 1, m.actionCatalog);
                            m.body = "actionCatalog";
                            continue;
                        }
                    case 51: {
                            if (u !== 2)
                                break;
                            m.termAction = $root.rterm.v1.TermAction.decode(r, r.size(), $undefined, q + 1, m.termAction);
                            m.body = "termAction";
                            continue;
                        }
                    case 52: {
                            if (u !== 2)
                                break;
                            m.termActionResult = $root.rterm.v1.TermActionResult.decode(r, r.size(), $undefined, q + 1, m.termActionResult);
                            m.body = "termActionResult";
                            continue;
                        }
                    case 53: {
                            if (u !== 2)
                                break;
                            m.appState = $root.rterm.v1.AppState.decode(r, r.size(), $undefined, q + 1, m.appState);
                            m.body = "appState";
                            continue;
                        }
                    case 54: {
                            if (u !== 2)
                                break;
                            m.appNotice = $root.rterm.v1.AppNotice.decode(r, r.size(), $undefined, q + 1, m.appNotice);
                            m.body = "appNotice";
                            continue;
                        }
                    case 55: {
                            if (u !== 2)
                                break;
                            m.commandList = $root.rterm.v1.CommandList.decode(r, r.size(), $undefined, q + 1, m.commandList);
                            m.body = "commandList";
                            continue;
                        }
                    case 56: {
                            if (u !== 2)
                                break;
                            m.commandListReq = $root.rterm.v1.CommandListReq.decode(r, r.size(), $undefined, q + 1, m.commandListReq);
                            m.body = "commandListReq";
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            Frame.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.Frame)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.Frame: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.Frame();
                if (d.channel != null) {
                    if ($Number(d.channel) !== 0) {
                        m.channel = d.channel >>> 0;
                    }
                }
                if (d.hello != null) {
                    if (!$util.isObject(d.hello))
                        throw $TypeError(".rterm.v1.Frame.hello: object expected");
                    m.hello = $root.rterm.v1.Hello.fromObject(d.hello, q + 1);
                }
                if (d.helloAck != null) {
                    if (!$util.isObject(d.helloAck))
                        throw $TypeError(".rterm.v1.Frame.helloAck: object expected");
                    m.helloAck = $root.rterm.v1.HelloAck.fromObject(d.helloAck, q + 1);
                }
                if (d.ping != null) {
                    if (!$util.isObject(d.ping))
                        throw $TypeError(".rterm.v1.Frame.ping: object expected");
                    m.ping = $root.rterm.v1.Ping.fromObject(d.ping, q + 1);
                }
                if (d.pong != null) {
                    if (!$util.isObject(d.pong))
                        throw $TypeError(".rterm.v1.Frame.pong: object expected");
                    m.pong = $root.rterm.v1.Pong.fromObject(d.pong, q + 1);
                }
                if (d.error != null) {
                    if (!$util.isObject(d.error))
                        throw $TypeError(".rterm.v1.Frame.error: object expected");
                    m.error = $root.rterm.v1.Error.fromObject(d.error, q + 1);
                }
                if (d.bye != null) {
                    if (!$util.isObject(d.bye))
                        throw $TypeError(".rterm.v1.Frame.bye: object expected");
                    m.bye = $root.rterm.v1.Bye.fromObject(d.bye, q + 1);
                }
                if (d.termOpen != null) {
                    if (!$util.isObject(d.termOpen))
                        throw $TypeError(".rterm.v1.Frame.termOpen: object expected");
                    m.termOpen = $root.rterm.v1.TermOpen.fromObject(d.termOpen, q + 1);
                }
                if (d.termOpened != null) {
                    if (!$util.isObject(d.termOpened))
                        throw $TypeError(".rterm.v1.Frame.termOpened: object expected");
                    m.termOpened = $root.rterm.v1.TermOpened.fromObject(d.termOpened, q + 1);
                }
                if (d.termList != null) {
                    if (!$util.isObject(d.termList))
                        throw $TypeError(".rterm.v1.Frame.termList: object expected");
                    m.termList = $root.rterm.v1.TermList.fromObject(d.termList, q + 1);
                }
                if (d.termListResp != null) {
                    if (!$util.isObject(d.termListResp))
                        throw $TypeError(".rterm.v1.Frame.termListResp: object expected");
                    m.termListResp = $root.rterm.v1.TermListResp.fromObject(d.termListResp, q + 1);
                }
                if (d.termAttach != null) {
                    if (!$util.isObject(d.termAttach))
                        throw $TypeError(".rterm.v1.Frame.termAttach: object expected");
                    m.termAttach = $root.rterm.v1.TermAttach.fromObject(d.termAttach, q + 1);
                }
                if (d.termClose != null) {
                    if (!$util.isObject(d.termClose))
                        throw $TypeError(".rterm.v1.Frame.termClose: object expected");
                    m.termClose = $root.rterm.v1.TermClose.fromObject(d.termClose, q + 1);
                }
                if (d.termOutput != null) {
                    if (!$util.isObject(d.termOutput))
                        throw $TypeError(".rterm.v1.Frame.termOutput: object expected");
                    m.termOutput = $root.rterm.v1.TermOutput.fromObject(d.termOutput, q + 1);
                }
                if (d.termInput != null) {
                    if (!$util.isObject(d.termInput))
                        throw $TypeError(".rterm.v1.Frame.termInput: object expected");
                    m.termInput = $root.rterm.v1.TermInput.fromObject(d.termInput, q + 1);
                }
                if (d.termSubmit != null) {
                    if (!$util.isObject(d.termSubmit))
                        throw $TypeError(".rterm.v1.Frame.termSubmit: object expected");
                    m.termSubmit = $root.rterm.v1.TermSubmit.fromObject(d.termSubmit, q + 1);
                }
                if (d.termResize != null) {
                    if (!$util.isObject(d.termResize))
                        throw $TypeError(".rterm.v1.Frame.termResize: object expected");
                    m.termResize = $root.rterm.v1.TermResize.fromObject(d.termResize, q + 1);
                }
                if (d.termAck != null) {
                    if (!$util.isObject(d.termAck))
                        throw $TypeError(".rterm.v1.Frame.termAck: object expected");
                    m.termAck = $root.rterm.v1.TermAck.fromObject(d.termAck, q + 1);
                }
                if (d.termState != null) {
                    if (!$util.isObject(d.termState))
                        throw $TypeError(".rterm.v1.Frame.termState: object expected");
                    m.termState = $root.rterm.v1.TermState.fromObject(d.termState, q + 1);
                }
                if (d.termExit != null) {
                    if (!$util.isObject(d.termExit))
                        throw $TypeError(".rterm.v1.Frame.termExit: object expected");
                    m.termExit = $root.rterm.v1.TermExit.fromObject(d.termExit, q + 1);
                }
                if (d.fileBegin != null) {
                    if (!$util.isObject(d.fileBegin))
                        throw $TypeError(".rterm.v1.Frame.fileBegin: object expected");
                    m.fileBegin = $root.rterm.v1.FileBegin.fromObject(d.fileBegin, q + 1);
                }
                if (d.fileAccept != null) {
                    if (!$util.isObject(d.fileAccept))
                        throw $TypeError(".rterm.v1.Frame.fileAccept: object expected");
                    m.fileAccept = $root.rterm.v1.FileAccept.fromObject(d.fileAccept, q + 1);
                }
                if (d.fileChunk != null) {
                    if (!$util.isObject(d.fileChunk))
                        throw $TypeError(".rterm.v1.Frame.fileChunk: object expected");
                    m.fileChunk = $root.rterm.v1.FileChunk.fromObject(d.fileChunk, q + 1);
                }
                if (d.fileAck != null) {
                    if (!$util.isObject(d.fileAck))
                        throw $TypeError(".rterm.v1.Frame.fileAck: object expected");
                    m.fileAck = $root.rterm.v1.FileAck.fromObject(d.fileAck, q + 1);
                }
                if (d.fileEnd != null) {
                    if (!$util.isObject(d.fileEnd))
                        throw $TypeError(".rterm.v1.Frame.fileEnd: object expected");
                    m.fileEnd = $root.rterm.v1.FileEnd.fromObject(d.fileEnd, q + 1);
                }
                if (d.fileDone != null) {
                    if (!$util.isObject(d.fileDone))
                        throw $TypeError(".rterm.v1.Frame.fileDone: object expected");
                    m.fileDone = $root.rterm.v1.FileDone.fromObject(d.fileDone, q + 1);
                }
                if (d.fileCancel != null) {
                    if (!$util.isObject(d.fileCancel))
                        throw $TypeError(".rterm.v1.Frame.fileCancel: object expected");
                    m.fileCancel = $root.rterm.v1.FileCancel.fromObject(d.fileCancel, q + 1);
                }
                if (d.actionCatalog != null) {
                    if (!$util.isObject(d.actionCatalog))
                        throw $TypeError(".rterm.v1.Frame.actionCatalog: object expected");
                    m.actionCatalog = $root.rterm.v1.ActionCatalog.fromObject(d.actionCatalog, q + 1);
                }
                if (d.termAction != null) {
                    if (!$util.isObject(d.termAction))
                        throw $TypeError(".rterm.v1.Frame.termAction: object expected");
                    m.termAction = $root.rterm.v1.TermAction.fromObject(d.termAction, q + 1);
                }
                if (d.termActionResult != null) {
                    if (!$util.isObject(d.termActionResult))
                        throw $TypeError(".rterm.v1.Frame.termActionResult: object expected");
                    m.termActionResult = $root.rterm.v1.TermActionResult.fromObject(d.termActionResult, q + 1);
                }
                if (d.appState != null) {
                    if (!$util.isObject(d.appState))
                        throw $TypeError(".rterm.v1.Frame.appState: object expected");
                    m.appState = $root.rterm.v1.AppState.fromObject(d.appState, q + 1);
                }
                if (d.appNotice != null) {
                    if (!$util.isObject(d.appNotice))
                        throw $TypeError(".rterm.v1.Frame.appNotice: object expected");
                    m.appNotice = $root.rterm.v1.AppNotice.fromObject(d.appNotice, q + 1);
                }
                if (d.commandList != null) {
                    if (!$util.isObject(d.commandList))
                        throw $TypeError(".rterm.v1.Frame.commandList: object expected");
                    m.commandList = $root.rterm.v1.CommandList.fromObject(d.commandList, q + 1);
                }
                if (d.commandListReq != null) {
                    if (!$util.isObject(d.commandListReq))
                        throw $TypeError(".rterm.v1.Frame.commandListReq: object expected");
                    m.commandListReq = $root.rterm.v1.CommandListReq.fromObject(d.commandListReq, q + 1);
                }
                return m;
            };

            Frame.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.channel = 0;
                }
                if (m.channel != null && $Object.hasOwnProperty.call(m, "channel")) {
                    d.channel = m.channel;
                }
                if (m.hello != null && $Object.hasOwnProperty.call(m, "hello")) {
                    d.hello = $root.rterm.v1.Hello.toObject(m.hello, o, q + 1);
                    if (o.oneofs)
                        d.body = "hello";
                }
                if (m.helloAck != null && $Object.hasOwnProperty.call(m, "helloAck")) {
                    d.helloAck = $root.rterm.v1.HelloAck.toObject(m.helloAck, o, q + 1);
                    if (o.oneofs)
                        d.body = "helloAck";
                }
                if (m.ping != null && $Object.hasOwnProperty.call(m, "ping")) {
                    d.ping = $root.rterm.v1.Ping.toObject(m.ping, o, q + 1);
                    if (o.oneofs)
                        d.body = "ping";
                }
                if (m.pong != null && $Object.hasOwnProperty.call(m, "pong")) {
                    d.pong = $root.rterm.v1.Pong.toObject(m.pong, o, q + 1);
                    if (o.oneofs)
                        d.body = "pong";
                }
                if (m.error != null && $Object.hasOwnProperty.call(m, "error")) {
                    d.error = $root.rterm.v1.Error.toObject(m.error, o, q + 1);
                    if (o.oneofs)
                        d.body = "error";
                }
                if (m.bye != null && $Object.hasOwnProperty.call(m, "bye")) {
                    d.bye = $root.rterm.v1.Bye.toObject(m.bye, o, q + 1);
                    if (o.oneofs)
                        d.body = "bye";
                }
                if (m.termOpen != null && $Object.hasOwnProperty.call(m, "termOpen")) {
                    d.termOpen = $root.rterm.v1.TermOpen.toObject(m.termOpen, o, q + 1);
                    if (o.oneofs)
                        d.body = "termOpen";
                }
                if (m.termOpened != null && $Object.hasOwnProperty.call(m, "termOpened")) {
                    d.termOpened = $root.rterm.v1.TermOpened.toObject(m.termOpened, o, q + 1);
                    if (o.oneofs)
                        d.body = "termOpened";
                }
                if (m.termList != null && $Object.hasOwnProperty.call(m, "termList")) {
                    d.termList = $root.rterm.v1.TermList.toObject(m.termList, o, q + 1);
                    if (o.oneofs)
                        d.body = "termList";
                }
                if (m.termListResp != null && $Object.hasOwnProperty.call(m, "termListResp")) {
                    d.termListResp = $root.rterm.v1.TermListResp.toObject(m.termListResp, o, q + 1);
                    if (o.oneofs)
                        d.body = "termListResp";
                }
                if (m.termAttach != null && $Object.hasOwnProperty.call(m, "termAttach")) {
                    d.termAttach = $root.rterm.v1.TermAttach.toObject(m.termAttach, o, q + 1);
                    if (o.oneofs)
                        d.body = "termAttach";
                }
                if (m.termClose != null && $Object.hasOwnProperty.call(m, "termClose")) {
                    d.termClose = $root.rterm.v1.TermClose.toObject(m.termClose, o, q + 1);
                    if (o.oneofs)
                        d.body = "termClose";
                }
                if (m.termOutput != null && $Object.hasOwnProperty.call(m, "termOutput")) {
                    d.termOutput = $root.rterm.v1.TermOutput.toObject(m.termOutput, o, q + 1);
                    if (o.oneofs)
                        d.body = "termOutput";
                }
                if (m.termInput != null && $Object.hasOwnProperty.call(m, "termInput")) {
                    d.termInput = $root.rterm.v1.TermInput.toObject(m.termInput, o, q + 1);
                    if (o.oneofs)
                        d.body = "termInput";
                }
                if (m.termSubmit != null && $Object.hasOwnProperty.call(m, "termSubmit")) {
                    d.termSubmit = $root.rterm.v1.TermSubmit.toObject(m.termSubmit, o, q + 1);
                    if (o.oneofs)
                        d.body = "termSubmit";
                }
                if (m.termResize != null && $Object.hasOwnProperty.call(m, "termResize")) {
                    d.termResize = $root.rterm.v1.TermResize.toObject(m.termResize, o, q + 1);
                    if (o.oneofs)
                        d.body = "termResize";
                }
                if (m.termAck != null && $Object.hasOwnProperty.call(m, "termAck")) {
                    d.termAck = $root.rterm.v1.TermAck.toObject(m.termAck, o, q + 1);
                    if (o.oneofs)
                        d.body = "termAck";
                }
                if (m.termState != null && $Object.hasOwnProperty.call(m, "termState")) {
                    d.termState = $root.rterm.v1.TermState.toObject(m.termState, o, q + 1);
                    if (o.oneofs)
                        d.body = "termState";
                }
                if (m.termExit != null && $Object.hasOwnProperty.call(m, "termExit")) {
                    d.termExit = $root.rterm.v1.TermExit.toObject(m.termExit, o, q + 1);
                    if (o.oneofs)
                        d.body = "termExit";
                }
                if (m.fileBegin != null && $Object.hasOwnProperty.call(m, "fileBegin")) {
                    d.fileBegin = $root.rterm.v1.FileBegin.toObject(m.fileBegin, o, q + 1);
                    if (o.oneofs)
                        d.body = "fileBegin";
                }
                if (m.fileAccept != null && $Object.hasOwnProperty.call(m, "fileAccept")) {
                    d.fileAccept = $root.rterm.v1.FileAccept.toObject(m.fileAccept, o, q + 1);
                    if (o.oneofs)
                        d.body = "fileAccept";
                }
                if (m.fileChunk != null && $Object.hasOwnProperty.call(m, "fileChunk")) {
                    d.fileChunk = $root.rterm.v1.FileChunk.toObject(m.fileChunk, o, q + 1);
                    if (o.oneofs)
                        d.body = "fileChunk";
                }
                if (m.fileAck != null && $Object.hasOwnProperty.call(m, "fileAck")) {
                    d.fileAck = $root.rterm.v1.FileAck.toObject(m.fileAck, o, q + 1);
                    if (o.oneofs)
                        d.body = "fileAck";
                }
                if (m.fileEnd != null && $Object.hasOwnProperty.call(m, "fileEnd")) {
                    d.fileEnd = $root.rterm.v1.FileEnd.toObject(m.fileEnd, o, q + 1);
                    if (o.oneofs)
                        d.body = "fileEnd";
                }
                if (m.fileDone != null && $Object.hasOwnProperty.call(m, "fileDone")) {
                    d.fileDone = $root.rterm.v1.FileDone.toObject(m.fileDone, o, q + 1);
                    if (o.oneofs)
                        d.body = "fileDone";
                }
                if (m.fileCancel != null && $Object.hasOwnProperty.call(m, "fileCancel")) {
                    d.fileCancel = $root.rterm.v1.FileCancel.toObject(m.fileCancel, o, q + 1);
                    if (o.oneofs)
                        d.body = "fileCancel";
                }
                if (m.actionCatalog != null && $Object.hasOwnProperty.call(m, "actionCatalog")) {
                    d.actionCatalog = $root.rterm.v1.ActionCatalog.toObject(m.actionCatalog, o, q + 1);
                    if (o.oneofs)
                        d.body = "actionCatalog";
                }
                if (m.termAction != null && $Object.hasOwnProperty.call(m, "termAction")) {
                    d.termAction = $root.rterm.v1.TermAction.toObject(m.termAction, o, q + 1);
                    if (o.oneofs)
                        d.body = "termAction";
                }
                if (m.termActionResult != null && $Object.hasOwnProperty.call(m, "termActionResult")) {
                    d.termActionResult = $root.rterm.v1.TermActionResult.toObject(m.termActionResult, o, q + 1);
                    if (o.oneofs)
                        d.body = "termActionResult";
                }
                if (m.appState != null && $Object.hasOwnProperty.call(m, "appState")) {
                    d.appState = $root.rterm.v1.AppState.toObject(m.appState, o, q + 1);
                    if (o.oneofs)
                        d.body = "appState";
                }
                if (m.appNotice != null && $Object.hasOwnProperty.call(m, "appNotice")) {
                    d.appNotice = $root.rterm.v1.AppNotice.toObject(m.appNotice, o, q + 1);
                    if (o.oneofs)
                        d.body = "appNotice";
                }
                if (m.commandList != null && $Object.hasOwnProperty.call(m, "commandList")) {
                    d.commandList = $root.rterm.v1.CommandList.toObject(m.commandList, o, q + 1);
                    if (o.oneofs)
                        d.body = "commandList";
                }
                if (m.commandListReq != null && $Object.hasOwnProperty.call(m, "commandListReq")) {
                    d.commandListReq = $root.rterm.v1.CommandListReq.toObject(m.commandListReq, o, q + 1);
                    if (o.oneofs)
                        d.body = "commandListReq";
                }
                return d;
            };

            Frame.prototype.toJSON = function() {
                return Frame.toObject(this, $protobuf.util.toJSONOptions);
            };

            Frame.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.Frame";
            };

            return Frame;
        })();

        v1.Hello = (function() {

            const Hello = function (p) {
                this.features = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            Hello.prototype.protoVer = 0;
            Hello.prototype.minProtoVer = 0;
            Hello.prototype.appVersion = "";
            Hello.prototype.features = $util.emptyArray;

            Hello.create = function(properties) {
                return new Hello(properties);
            };

            Hello.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.protoVer != null && $Object.hasOwnProperty.call(m, "protoVer") && m.protoVer !== 0)
                    w.uint32(8).uint32(m.protoVer);
                if (m.minProtoVer != null && $Object.hasOwnProperty.call(m, "minProtoVer") && m.minProtoVer !== 0)
                    w.uint32(16).uint32(m.minProtoVer);
                if (m.appVersion != null && $Object.hasOwnProperty.call(m, "appVersion") && m.appVersion !== "")
                    w.uint32(26).string(m.appVersion);
                if (m.features != null && m.features.length) {
                    for (var i = 0; i < m.features.length; ++i)
                        w.uint32(34).string(m.features[i]);
                }
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            Hello.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.Hello();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.protoVer = v;
                            else
                                delete m.protoVer;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.minProtoVer = v;
                            else
                                delete m.minProtoVer;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.appVersion = v;
                            else
                                delete m.appVersion;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if (!(m.features && m.features.length))
                                m.features = [];
                            m.features.push(r.stringVerify());
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            Hello.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.Hello)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.Hello: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.Hello();
                if (d.protoVer != null) {
                    if ($Number(d.protoVer) !== 0) {
                        m.protoVer = d.protoVer >>> 0;
                    }
                }
                if (d.minProtoVer != null) {
                    if ($Number(d.minProtoVer) !== 0) {
                        m.minProtoVer = d.minProtoVer >>> 0;
                    }
                }
                if (d.appVersion != null) {
                    if (typeof d.appVersion !== "string" || d.appVersion.length) {
                        m.appVersion = $String(d.appVersion);
                    }
                }
                if (d.features) {
                    if (!$Array.isArray(d.features))
                        throw $TypeError(".rterm.v1.Hello.features: array expected");
                    m.features = $Array(d.features.length);
                    for (var i = 0; i < d.features.length; ++i) {
                        m.features[i] = $String(d.features[i]);
                    }
                }
                return m;
            };

            Hello.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.features = [];
                }
                if (o.defaults) {
                    d.protoVer = 0;
                    d.minProtoVer = 0;
                    d.appVersion = "";
                }
                if (m.protoVer != null && $Object.hasOwnProperty.call(m, "protoVer")) {
                    d.protoVer = m.protoVer;
                }
                if (m.minProtoVer != null && $Object.hasOwnProperty.call(m, "minProtoVer")) {
                    d.minProtoVer = m.minProtoVer;
                }
                if (m.appVersion != null && $Object.hasOwnProperty.call(m, "appVersion")) {
                    d.appVersion = m.appVersion;
                }
                if (m.features && m.features.length) {
                    d.features = $Array(m.features.length);
                    for (var j = 0; j < m.features.length; ++j) {
                        d.features[j] = m.features[j];
                    }
                }
                return d;
            };

            Hello.prototype.toJSON = function() {
                return Hello.toObject(this, $protobuf.util.toJSONOptions);
            };

            Hello.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.Hello";
            };

            return Hello;
        })();

        v1.HelloAck = (function() {

            const HelloAck = function (p) {
                this.features = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            HelloAck.prototype.protoVer = 0;
            HelloAck.prototype.appVersion = "";
            HelloAck.prototype.features = $util.emptyArray;
            HelloAck.prototype.host = null;

            HelloAck.create = function(properties) {
                return new HelloAck(properties);
            };

            HelloAck.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.protoVer != null && $Object.hasOwnProperty.call(m, "protoVer") && m.protoVer !== 0)
                    w.uint32(8).uint32(m.protoVer);
                if (m.appVersion != null && $Object.hasOwnProperty.call(m, "appVersion") && m.appVersion !== "")
                    w.uint32(18).string(m.appVersion);
                if (m.features != null && m.features.length) {
                    for (var i = 0; i < m.features.length; ++i)
                        w.uint32(26).string(m.features[i]);
                }
                if (m.host != null && $Object.hasOwnProperty.call(m, "host"))
                    $root.rterm.v1.HostInfo.encode(m.host, w.uint32(34).fork(), q + 1).ldelim();
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            HelloAck.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.HelloAck();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.protoVer = v;
                            else
                                delete m.protoVer;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.appVersion = v;
                            else
                                delete m.appVersion;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if (!(m.features && m.features.length))
                                m.features = [];
                            m.features.push(r.stringVerify());
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            m.host = $root.rterm.v1.HostInfo.decode(r, r.size(), $undefined, q + 1, m.host);
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            HelloAck.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.HelloAck)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.HelloAck: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.HelloAck();
                if (d.protoVer != null) {
                    if ($Number(d.protoVer) !== 0) {
                        m.protoVer = d.protoVer >>> 0;
                    }
                }
                if (d.appVersion != null) {
                    if (typeof d.appVersion !== "string" || d.appVersion.length) {
                        m.appVersion = $String(d.appVersion);
                    }
                }
                if (d.features) {
                    if (!$Array.isArray(d.features))
                        throw $TypeError(".rterm.v1.HelloAck.features: array expected");
                    m.features = $Array(d.features.length);
                    for (var i = 0; i < d.features.length; ++i) {
                        m.features[i] = $String(d.features[i]);
                    }
                }
                if (d.host != null) {
                    if (!$util.isObject(d.host))
                        throw $TypeError(".rterm.v1.HelloAck.host: object expected");
                    m.host = $root.rterm.v1.HostInfo.fromObject(d.host, q + 1);
                }
                return m;
            };

            HelloAck.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.features = [];
                }
                if (o.defaults) {
                    d.protoVer = 0;
                    d.appVersion = "";
                    d.host = null;
                }
                if (m.protoVer != null && $Object.hasOwnProperty.call(m, "protoVer")) {
                    d.protoVer = m.protoVer;
                }
                if (m.appVersion != null && $Object.hasOwnProperty.call(m, "appVersion")) {
                    d.appVersion = m.appVersion;
                }
                if (m.features && m.features.length) {
                    d.features = $Array(m.features.length);
                    for (var j = 0; j < m.features.length; ++j) {
                        d.features[j] = m.features[j];
                    }
                }
                if (m.host != null && $Object.hasOwnProperty.call(m, "host")) {
                    d.host = $root.rterm.v1.HostInfo.toObject(m.host, o, q + 1);
                }
                return d;
            };

            HelloAck.prototype.toJSON = function() {
                return HelloAck.toObject(this, $protobuf.util.toJSONOptions);
            };

            HelloAck.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.HelloAck";
            };

            return HelloAck;
        })();

        v1.HostInfo = (function() {

            const HostInfo = function (p) {
                this.shells = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            HostInfo.prototype.platform = "";
            HostInfo.prototype.arch = "";
            HostInfo.prototype.hostname = "";
            HostInfo.prototype.username = "";
            HostInfo.prototype.homeDir = "";
            HostInfo.prototype.shells = $util.emptyArray;
            HostInfo.prototype.claudeAvailable = false;
            HostInfo.prototype.claudeVersion = "";
            HostInfo.prototype.maxFileSize = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

            HostInfo.create = function(properties) {
                return new HostInfo(properties);
            };

            HostInfo.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.platform != null && $Object.hasOwnProperty.call(m, "platform") && m.platform !== "")
                    w.uint32(10).string(m.platform);
                if (m.arch != null && $Object.hasOwnProperty.call(m, "arch") && m.arch !== "")
                    w.uint32(18).string(m.arch);
                if (m.hostname != null && $Object.hasOwnProperty.call(m, "hostname") && m.hostname !== "")
                    w.uint32(26).string(m.hostname);
                if (m.username != null && $Object.hasOwnProperty.call(m, "username") && m.username !== "")
                    w.uint32(34).string(m.username);
                if (m.homeDir != null && $Object.hasOwnProperty.call(m, "homeDir") && m.homeDir !== "")
                    w.uint32(42).string(m.homeDir);
                if (m.shells != null && m.shells.length) {
                    for (var i = 0; i < m.shells.length; ++i)
                        $root.rterm.v1.ShellInfo.encode(m.shells[i], w.uint32(50).fork(), q + 1).ldelim();
                }
                if (m.claudeAvailable != null && $Object.hasOwnProperty.call(m, "claudeAvailable") && m.claudeAvailable !== false)
                    w.uint32(56).bool(m.claudeAvailable);
                if (m.claudeVersion != null && $Object.hasOwnProperty.call(m, "claudeVersion") && m.claudeVersion !== "")
                    w.uint32(66).string(m.claudeVersion);
                if (m.maxFileSize != null && $Object.hasOwnProperty.call(m, "maxFileSize") && (typeof m.maxFileSize === "object" ? m.maxFileSize.low || m.maxFileSize.high : m.maxFileSize !== 0))
                    w.uint32(72).uint64(m.maxFileSize);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            HostInfo.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.HostInfo();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.platform = v;
                            else
                                delete m.platform;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.arch = v;
                            else
                                delete m.arch;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.hostname = v;
                            else
                                delete m.hostname;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.username = v;
                            else
                                delete m.username;
                            continue;
                        }
                    case 5: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.homeDir = v;
                            else
                                delete m.homeDir;
                            continue;
                        }
                    case 6: {
                            if (u !== 2)
                                break;
                            if (!(m.shells && m.shells.length))
                                m.shells = [];
                            m.shells.push($root.rterm.v1.ShellInfo.decode(r, r.size(), $undefined, q + 1));
                            continue;
                        }
                    case 7: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.claudeAvailable = v;
                            else
                                delete m.claudeAvailable;
                            continue;
                        }
                    case 8: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.claudeVersion = v;
                            else
                                delete m.claudeVersion;
                            continue;
                        }
                    case 9: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.maxFileSize = v;
                            else
                                delete m.maxFileSize;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            HostInfo.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.HostInfo)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.HostInfo: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.HostInfo();
                if (d.platform != null) {
                    if (typeof d.platform !== "string" || d.platform.length) {
                        m.platform = $String(d.platform);
                    }
                }
                if (d.arch != null) {
                    if (typeof d.arch !== "string" || d.arch.length) {
                        m.arch = $String(d.arch);
                    }
                }
                if (d.hostname != null) {
                    if (typeof d.hostname !== "string" || d.hostname.length) {
                        m.hostname = $String(d.hostname);
                    }
                }
                if (d.username != null) {
                    if (typeof d.username !== "string" || d.username.length) {
                        m.username = $String(d.username);
                    }
                }
                if (d.homeDir != null) {
                    if (typeof d.homeDir !== "string" || d.homeDir.length) {
                        m.homeDir = $String(d.homeDir);
                    }
                }
                if (d.shells) {
                    if (!$Array.isArray(d.shells))
                        throw $TypeError(".rterm.v1.HostInfo.shells: array expected");
                    m.shells = $Array(d.shells.length);
                    for (var i = 0; i < d.shells.length; ++i) {
                        if (!$util.isObject(d.shells[i]))
                            throw $TypeError(".rterm.v1.HostInfo.shells: object expected");
                        m.shells[i] = $root.rterm.v1.ShellInfo.fromObject(d.shells[i], q + 1);
                    }
                }
                if (d.claudeAvailable != null) {
                    if (d.claudeAvailable) {
                        m.claudeAvailable = $Boolean(d.claudeAvailable);
                    }
                }
                if (d.claudeVersion != null) {
                    if (typeof d.claudeVersion !== "string" || d.claudeVersion.length) {
                        m.claudeVersion = $String(d.claudeVersion);
                    }
                }
                if (d.maxFileSize != null) {
                    if (typeof d.maxFileSize === "object" ? d.maxFileSize.low || d.maxFileSize.high : $Number(d.maxFileSize) !== 0) {
                        if ($util.Long)
                            m.maxFileSize = $util.Long.fromValue(d.maxFileSize, true);
                        else if (typeof d.maxFileSize === "string")
                            m.maxFileSize = $parseInt(d.maxFileSize, 10);
                        else if (typeof d.maxFileSize === "number")
                            m.maxFileSize = d.maxFileSize;
                        else if (typeof d.maxFileSize === "object")
                            m.maxFileSize = new $util.LongBits(d.maxFileSize.low >>> 0, d.maxFileSize.high >>> 0).toNumber(true);
                    }
                }
                return m;
            };

            HostInfo.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.shells = [];
                }
                if (o.defaults) {
                    d.platform = "";
                    d.arch = "";
                    d.hostname = "";
                    d.username = "";
                    d.homeDir = "";
                    d.claudeAvailable = false;
                    d.claudeVersion = "";
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.maxFileSize = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.maxFileSize = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                }
                if (m.platform != null && $Object.hasOwnProperty.call(m, "platform")) {
                    d.platform = m.platform;
                }
                if (m.arch != null && $Object.hasOwnProperty.call(m, "arch")) {
                    d.arch = m.arch;
                }
                if (m.hostname != null && $Object.hasOwnProperty.call(m, "hostname")) {
                    d.hostname = m.hostname;
                }
                if (m.username != null && $Object.hasOwnProperty.call(m, "username")) {
                    d.username = m.username;
                }
                if (m.homeDir != null && $Object.hasOwnProperty.call(m, "homeDir")) {
                    d.homeDir = m.homeDir;
                }
                if (m.shells && m.shells.length) {
                    d.shells = $Array(m.shells.length);
                    for (var j = 0; j < m.shells.length; ++j) {
                        d.shells[j] = $root.rterm.v1.ShellInfo.toObject(m.shells[j], o, q + 1);
                    }
                }
                if (m.claudeAvailable != null && $Object.hasOwnProperty.call(m, "claudeAvailable")) {
                    d.claudeAvailable = m.claudeAvailable;
                }
                if (m.claudeVersion != null && $Object.hasOwnProperty.call(m, "claudeVersion")) {
                    d.claudeVersion = m.claudeVersion;
                }
                if (m.maxFileSize != null && $Object.hasOwnProperty.call(m, "maxFileSize")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.maxFileSize = typeof m.maxFileSize === "number" ? $BigInt(m.maxFileSize) : $util.Long.fromBits(m.maxFileSize.low >>> 0, m.maxFileSize.high >>> 0, true).toBigInt();
                    else if (typeof m.maxFileSize === "number")
                        d.maxFileSize = o.longs === $String ? $String(m.maxFileSize) : m.maxFileSize;
                    else
                        d.maxFileSize = o.longs === $String ? $util.Long.prototype.toString.call(m.maxFileSize) : o.longs === $Number ? new $util.LongBits(m.maxFileSize.low >>> 0, m.maxFileSize.high >>> 0).toNumber(true) : m.maxFileSize;
                }
                return d;
            };

            HostInfo.prototype.toJSON = function() {
                return HostInfo.toObject(this, $protobuf.util.toJSONOptions);
            };

            HostInfo.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.HostInfo";
            };

            return HostInfo;
        })();

        v1.ShellInfo = (function() {

            const ShellInfo = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            ShellInfo.prototype.id = "";
            ShellInfo.prototype.name = "";
            ShellInfo.prototype.path = "";
            ShellInfo.prototype.isDefault = false;

            ShellInfo.create = function(properties) {
                return new ShellInfo(properties);
            };

            ShellInfo.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.id != null && $Object.hasOwnProperty.call(m, "id") && m.id !== "")
                    w.uint32(10).string(m.id);
                if (m.name != null && $Object.hasOwnProperty.call(m, "name") && m.name !== "")
                    w.uint32(18).string(m.name);
                if (m.path != null && $Object.hasOwnProperty.call(m, "path") && m.path !== "")
                    w.uint32(26).string(m.path);
                if (m.isDefault != null && $Object.hasOwnProperty.call(m, "isDefault") && m.isDefault !== false)
                    w.uint32(32).bool(m.isDefault);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            ShellInfo.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.ShellInfo();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.id = v;
                            else
                                delete m.id;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.name = v;
                            else
                                delete m.name;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.path = v;
                            else
                                delete m.path;
                            continue;
                        }
                    case 4: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.isDefault = v;
                            else
                                delete m.isDefault;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            ShellInfo.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.ShellInfo)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.ShellInfo: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.ShellInfo();
                if (d.id != null) {
                    if (typeof d.id !== "string" || d.id.length) {
                        m.id = $String(d.id);
                    }
                }
                if (d.name != null) {
                    if (typeof d.name !== "string" || d.name.length) {
                        m.name = $String(d.name);
                    }
                }
                if (d.path != null) {
                    if (typeof d.path !== "string" || d.path.length) {
                        m.path = $String(d.path);
                    }
                }
                if (d.isDefault != null) {
                    if (d.isDefault) {
                        m.isDefault = $Boolean(d.isDefault);
                    }
                }
                return m;
            };

            ShellInfo.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.id = "";
                    d.name = "";
                    d.path = "";
                    d.isDefault = false;
                }
                if (m.id != null && $Object.hasOwnProperty.call(m, "id")) {
                    d.id = m.id;
                }
                if (m.name != null && $Object.hasOwnProperty.call(m, "name")) {
                    d.name = m.name;
                }
                if (m.path != null && $Object.hasOwnProperty.call(m, "path")) {
                    d.path = m.path;
                }
                if (m.isDefault != null && $Object.hasOwnProperty.call(m, "isDefault")) {
                    d.isDefault = m.isDefault;
                }
                return d;
            };

            ShellInfo.prototype.toJSON = function() {
                return ShellInfo.toObject(this, $protobuf.util.toJSONOptions);
            };

            ShellInfo.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.ShellInfo";
            };

            return ShellInfo;
        })();

        v1.Ping = (function() {

            const Ping = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            Ping.prototype.ts = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

            Ping.create = function(properties) {
                return new Ping(properties);
            };

            Ping.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.ts != null && $Object.hasOwnProperty.call(m, "ts") && (typeof m.ts === "object" ? m.ts.low || m.ts.high : m.ts !== 0))
                    w.uint32(8).uint64(m.ts);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            Ping.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.Ping();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.ts = v;
                            else
                                delete m.ts;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            Ping.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.Ping)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.Ping: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.Ping();
                if (d.ts != null) {
                    if (typeof d.ts === "object" ? d.ts.low || d.ts.high : $Number(d.ts) !== 0) {
                        if ($util.Long)
                            m.ts = $util.Long.fromValue(d.ts, true);
                        else if (typeof d.ts === "string")
                            m.ts = $parseInt(d.ts, 10);
                        else if (typeof d.ts === "number")
                            m.ts = d.ts;
                        else if (typeof d.ts === "object")
                            m.ts = new $util.LongBits(d.ts.low >>> 0, d.ts.high >>> 0).toNumber(true);
                    }
                }
                return m;
            };

            Ping.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.ts = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.ts = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                }
                if (m.ts != null && $Object.hasOwnProperty.call(m, "ts")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.ts = typeof m.ts === "number" ? $BigInt(m.ts) : $util.Long.fromBits(m.ts.low >>> 0, m.ts.high >>> 0, true).toBigInt();
                    else if (typeof m.ts === "number")
                        d.ts = o.longs === $String ? $String(m.ts) : m.ts;
                    else
                        d.ts = o.longs === $String ? $util.Long.prototype.toString.call(m.ts) : o.longs === $Number ? new $util.LongBits(m.ts.low >>> 0, m.ts.high >>> 0).toNumber(true) : m.ts;
                }
                return d;
            };

            Ping.prototype.toJSON = function() {
                return Ping.toObject(this, $protobuf.util.toJSONOptions);
            };

            Ping.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.Ping";
            };

            return Ping;
        })();

        v1.Pong = (function() {

            const Pong = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            Pong.prototype.ts = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

            Pong.create = function(properties) {
                return new Pong(properties);
            };

            Pong.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.ts != null && $Object.hasOwnProperty.call(m, "ts") && (typeof m.ts === "object" ? m.ts.low || m.ts.high : m.ts !== 0))
                    w.uint32(8).uint64(m.ts);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            Pong.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.Pong();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.ts = v;
                            else
                                delete m.ts;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            Pong.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.Pong)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.Pong: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.Pong();
                if (d.ts != null) {
                    if (typeof d.ts === "object" ? d.ts.low || d.ts.high : $Number(d.ts) !== 0) {
                        if ($util.Long)
                            m.ts = $util.Long.fromValue(d.ts, true);
                        else if (typeof d.ts === "string")
                            m.ts = $parseInt(d.ts, 10);
                        else if (typeof d.ts === "number")
                            m.ts = d.ts;
                        else if (typeof d.ts === "object")
                            m.ts = new $util.LongBits(d.ts.low >>> 0, d.ts.high >>> 0).toNumber(true);
                    }
                }
                return m;
            };

            Pong.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.ts = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.ts = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                }
                if (m.ts != null && $Object.hasOwnProperty.call(m, "ts")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.ts = typeof m.ts === "number" ? $BigInt(m.ts) : $util.Long.fromBits(m.ts.low >>> 0, m.ts.high >>> 0, true).toBigInt();
                    else if (typeof m.ts === "number")
                        d.ts = o.longs === $String ? $String(m.ts) : m.ts;
                    else
                        d.ts = o.longs === $String ? $util.Long.prototype.toString.call(m.ts) : o.longs === $Number ? new $util.LongBits(m.ts.low >>> 0, m.ts.high >>> 0).toNumber(true) : m.ts;
                }
                return d;
            };

            Pong.prototype.toJSON = function() {
                return Pong.toObject(this, $protobuf.util.toJSONOptions);
            };

            Pong.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.Pong";
            };

            return Pong;
        })();

        v1.Error = (function() {

            const Error = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            Error.prototype.code = "";
            Error.prototype.message = "";
            Error.prototype.refId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

            Error.create = function(properties) {
                return new Error(properties);
            };

            Error.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.code != null && $Object.hasOwnProperty.call(m, "code") && m.code !== "")
                    w.uint32(10).string(m.code);
                if (m.message != null && $Object.hasOwnProperty.call(m, "message") && m.message !== "")
                    w.uint32(18).string(m.message);
                if (m.refId != null && $Object.hasOwnProperty.call(m, "refId") && (typeof m.refId === "object" ? m.refId.low || m.refId.high : m.refId !== 0))
                    w.uint32(24).uint64(m.refId);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            Error.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.Error();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.code = v;
                            else
                                delete m.code;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.message = v;
                            else
                                delete m.message;
                            continue;
                        }
                    case 3: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.refId = v;
                            else
                                delete m.refId;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            Error.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.Error)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.Error: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.Error();
                if (d.code != null) {
                    if (typeof d.code !== "string" || d.code.length) {
                        m.code = $String(d.code);
                    }
                }
                if (d.message != null) {
                    if (typeof d.message !== "string" || d.message.length) {
                        m.message = $String(d.message);
                    }
                }
                if (d.refId != null) {
                    if (typeof d.refId === "object" ? d.refId.low || d.refId.high : $Number(d.refId) !== 0) {
                        if ($util.Long)
                            m.refId = $util.Long.fromValue(d.refId, true);
                        else if (typeof d.refId === "string")
                            m.refId = $parseInt(d.refId, 10);
                        else if (typeof d.refId === "number")
                            m.refId = d.refId;
                        else if (typeof d.refId === "object")
                            m.refId = new $util.LongBits(d.refId.low >>> 0, d.refId.high >>> 0).toNumber(true);
                    }
                }
                return m;
            };

            Error.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.code = "";
                    d.message = "";
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.refId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.refId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                }
                if (m.code != null && $Object.hasOwnProperty.call(m, "code")) {
                    d.code = m.code;
                }
                if (m.message != null && $Object.hasOwnProperty.call(m, "message")) {
                    d.message = m.message;
                }
                if (m.refId != null && $Object.hasOwnProperty.call(m, "refId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.refId = typeof m.refId === "number" ? $BigInt(m.refId) : $util.Long.fromBits(m.refId.low >>> 0, m.refId.high >>> 0, true).toBigInt();
                    else if (typeof m.refId === "number")
                        d.refId = o.longs === $String ? $String(m.refId) : m.refId;
                    else
                        d.refId = o.longs === $String ? $util.Long.prototype.toString.call(m.refId) : o.longs === $Number ? new $util.LongBits(m.refId.low >>> 0, m.refId.high >>> 0).toNumber(true) : m.refId;
                }
                return d;
            };

            Error.prototype.toJSON = function() {
                return Error.toObject(this, $protobuf.util.toJSONOptions);
            };

            Error.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.Error";
            };

            return Error;
        })();

        v1.Bye = (function() {

            const Bye = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            Bye.prototype.reason = "";

            Bye.create = function(properties) {
                return new Bye(properties);
            };

            Bye.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.reason != null && $Object.hasOwnProperty.call(m, "reason") && m.reason !== "")
                    w.uint32(10).string(m.reason);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            Bye.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.Bye();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.reason = v;
                            else
                                delete m.reason;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            Bye.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.Bye)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.Bye: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.Bye();
                if (d.reason != null) {
                    if (typeof d.reason !== "string" || d.reason.length) {
                        m.reason = $String(d.reason);
                    }
                }
                return m;
            };

            Bye.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.reason = "";
                }
                if (m.reason != null && $Object.hasOwnProperty.call(m, "reason")) {
                    d.reason = m.reason;
                }
                return d;
            };

            Bye.prototype.toJSON = function() {
                return Bye.toObject(this, $protobuf.util.toJSONOptions);
            };

            Bye.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.Bye";
            };

            return Bye;
        })();

        v1.Profile = (function() {
            const valuesById = $Object.create(null), values = $Object.create(valuesById);
            values[valuesById[0] = "PROFILE_SHELL"] = 0;
            values[valuesById[1] = "PROFILE_CLAUDE"] = 1;
            values[valuesById[2] = "PROFILE_CUSTOM"] = 2;
            return values;
        })();

        v1.TermOpen = (function() {

            const TermOpen = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermOpen.prototype.reqId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermOpen.prototype.profile = 0;
            TermOpen.prototype.shellId = "";
            TermOpen.prototype.cwd = "";
            TermOpen.prototype.cols = 0;
            TermOpen.prototype.rows = 0;
            TermOpen.prototype.command = "";
            TermOpen.prototype.launch = null;

            TermOpen.create = function(properties) {
                return new TermOpen(properties);
            };

            TermOpen.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId") && (typeof m.reqId === "object" ? m.reqId.low || m.reqId.high : m.reqId !== 0))
                    w.uint32(8).uint64(m.reqId);
                if (m.profile != null && $Object.hasOwnProperty.call(m, "profile") && m.profile !== 0)
                    w.uint32(16).int32(m.profile);
                if (m.shellId != null && $Object.hasOwnProperty.call(m, "shellId") && m.shellId !== "")
                    w.uint32(26).string(m.shellId);
                if (m.cwd != null && $Object.hasOwnProperty.call(m, "cwd") && m.cwd !== "")
                    w.uint32(34).string(m.cwd);
                if (m.cols != null && $Object.hasOwnProperty.call(m, "cols") && m.cols !== 0)
                    w.uint32(40).uint32(m.cols);
                if (m.rows != null && $Object.hasOwnProperty.call(m, "rows") && m.rows !== 0)
                    w.uint32(48).uint32(m.rows);
                if (m.command != null && $Object.hasOwnProperty.call(m, "command") && m.command !== "")
                    w.uint32(58).string(m.command);
                if (m.launch != null && $Object.hasOwnProperty.call(m, "launch"))
                    $root.rterm.v1.LaunchOptions.encode(m.launch, w.uint32(66).fork(), q + 1).ldelim();
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermOpen.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermOpen();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.reqId = v;
                            else
                                delete m.reqId;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (v = r.int32())
                                m.profile = v;
                            else
                                delete m.profile;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.shellId = v;
                            else
                                delete m.shellId;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.cwd = v;
                            else
                                delete m.cwd;
                            continue;
                        }
                    case 5: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.cols = v;
                            else
                                delete m.cols;
                            continue;
                        }
                    case 6: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.rows = v;
                            else
                                delete m.rows;
                            continue;
                        }
                    case 7: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.command = v;
                            else
                                delete m.command;
                            continue;
                        }
                    case 8: {
                            if (u !== 2)
                                break;
                            m.launch = $root.rterm.v1.LaunchOptions.decode(r, r.size(), $undefined, q + 1, m.launch);
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermOpen.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermOpen)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermOpen: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermOpen();
                if (d.reqId != null) {
                    if (typeof d.reqId === "object" ? d.reqId.low || d.reqId.high : $Number(d.reqId) !== 0) {
                        if ($util.Long)
                            m.reqId = $util.Long.fromValue(d.reqId, true);
                        else if (typeof d.reqId === "string")
                            m.reqId = $parseInt(d.reqId, 10);
                        else if (typeof d.reqId === "number")
                            m.reqId = d.reqId;
                        else if (typeof d.reqId === "object")
                            m.reqId = new $util.LongBits(d.reqId.low >>> 0, d.reqId.high >>> 0).toNumber(true);
                    }
                }
                if (d.profile !== 0 && (typeof d.profile !== "string" || $root.rterm.v1.Profile[d.profile] !== 0)) {
                    switch (d.profile) {
                    case "PROFILE_SHELL":
                    case 0:
                        m.profile = 0;
                        break;
                    case "PROFILE_CLAUDE":
                    case 1:
                        m.profile = 1;
                        break;
                    case "PROFILE_CUSTOM":
                    case 2:
                        m.profile = 2;
                        break;
                    default:
                        if (typeof d.profile === "number" && (d.profile | 0) === d.profile)
                            m.profile = d.profile;
                    }
                }
                if (d.shellId != null) {
                    if (typeof d.shellId !== "string" || d.shellId.length) {
                        m.shellId = $String(d.shellId);
                    }
                }
                if (d.cwd != null) {
                    if (typeof d.cwd !== "string" || d.cwd.length) {
                        m.cwd = $String(d.cwd);
                    }
                }
                if (d.cols != null) {
                    if ($Number(d.cols) !== 0) {
                        m.cols = d.cols >>> 0;
                    }
                }
                if (d.rows != null) {
                    if ($Number(d.rows) !== 0) {
                        m.rows = d.rows >>> 0;
                    }
                }
                if (d.command != null) {
                    if (typeof d.command !== "string" || d.command.length) {
                        m.command = $String(d.command);
                    }
                }
                if (d.launch != null) {
                    if (!$util.isObject(d.launch))
                        throw $TypeError(".rterm.v1.TermOpen.launch: object expected");
                    m.launch = $root.rterm.v1.LaunchOptions.fromObject(d.launch, q + 1);
                }
                return m;
            };

            TermOpen.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.reqId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.reqId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.profile = o.enums === $String ? "PROFILE_SHELL" : 0;
                    d.shellId = "";
                    d.cwd = "";
                    d.cols = 0;
                    d.rows = 0;
                    d.command = "";
                    d.launch = null;
                }
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.reqId = typeof m.reqId === "number" ? $BigInt(m.reqId) : $util.Long.fromBits(m.reqId.low >>> 0, m.reqId.high >>> 0, true).toBigInt();
                    else if (typeof m.reqId === "number")
                        d.reqId = o.longs === $String ? $String(m.reqId) : m.reqId;
                    else
                        d.reqId = o.longs === $String ? $util.Long.prototype.toString.call(m.reqId) : o.longs === $Number ? new $util.LongBits(m.reqId.low >>> 0, m.reqId.high >>> 0).toNumber(true) : m.reqId;
                }
                if (m.profile != null && $Object.hasOwnProperty.call(m, "profile")) {
                    d.profile = o.enums === $String ? $root.rterm.v1.Profile[m.profile] === $undefined ? m.profile : $root.rterm.v1.Profile[m.profile] : m.profile;
                }
                if (m.shellId != null && $Object.hasOwnProperty.call(m, "shellId")) {
                    d.shellId = m.shellId;
                }
                if (m.cwd != null && $Object.hasOwnProperty.call(m, "cwd")) {
                    d.cwd = m.cwd;
                }
                if (m.cols != null && $Object.hasOwnProperty.call(m, "cols")) {
                    d.cols = m.cols;
                }
                if (m.rows != null && $Object.hasOwnProperty.call(m, "rows")) {
                    d.rows = m.rows;
                }
                if (m.command != null && $Object.hasOwnProperty.call(m, "command")) {
                    d.command = m.command;
                }
                if (m.launch != null && $Object.hasOwnProperty.call(m, "launch")) {
                    d.launch = $root.rterm.v1.LaunchOptions.toObject(m.launch, o, q + 1);
                }
                return d;
            };

            TermOpen.prototype.toJSON = function() {
                return TermOpen.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermOpen.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermOpen";
            };

            return TermOpen;
        })();

        v1.TermOpened = (function() {

            const TermOpened = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermOpened.prototype.reqId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermOpened.prototype.termId = "";
            TermOpened.prototype.channel = 0;
            TermOpened.prototype.title = "";
            TermOpened.prototype.shell = "";

            TermOpened.create = function(properties) {
                return new TermOpened(properties);
            };

            TermOpened.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId") && (typeof m.reqId === "object" ? m.reqId.low || m.reqId.high : m.reqId !== 0))
                    w.uint32(8).uint64(m.reqId);
                if (m.termId != null && $Object.hasOwnProperty.call(m, "termId") && m.termId !== "")
                    w.uint32(18).string(m.termId);
                if (m.channel != null && $Object.hasOwnProperty.call(m, "channel") && m.channel !== 0)
                    w.uint32(24).uint32(m.channel);
                if (m.title != null && $Object.hasOwnProperty.call(m, "title") && m.title !== "")
                    w.uint32(34).string(m.title);
                if (m.shell != null && $Object.hasOwnProperty.call(m, "shell") && m.shell !== "")
                    w.uint32(42).string(m.shell);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermOpened.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermOpened();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.reqId = v;
                            else
                                delete m.reqId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.termId = v;
                            else
                                delete m.termId;
                            continue;
                        }
                    case 3: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.channel = v;
                            else
                                delete m.channel;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.title = v;
                            else
                                delete m.title;
                            continue;
                        }
                    case 5: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.shell = v;
                            else
                                delete m.shell;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermOpened.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermOpened)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermOpened: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermOpened();
                if (d.reqId != null) {
                    if (typeof d.reqId === "object" ? d.reqId.low || d.reqId.high : $Number(d.reqId) !== 0) {
                        if ($util.Long)
                            m.reqId = $util.Long.fromValue(d.reqId, true);
                        else if (typeof d.reqId === "string")
                            m.reqId = $parseInt(d.reqId, 10);
                        else if (typeof d.reqId === "number")
                            m.reqId = d.reqId;
                        else if (typeof d.reqId === "object")
                            m.reqId = new $util.LongBits(d.reqId.low >>> 0, d.reqId.high >>> 0).toNumber(true);
                    }
                }
                if (d.termId != null) {
                    if (typeof d.termId !== "string" || d.termId.length) {
                        m.termId = $String(d.termId);
                    }
                }
                if (d.channel != null) {
                    if ($Number(d.channel) !== 0) {
                        m.channel = d.channel >>> 0;
                    }
                }
                if (d.title != null) {
                    if (typeof d.title !== "string" || d.title.length) {
                        m.title = $String(d.title);
                    }
                }
                if (d.shell != null) {
                    if (typeof d.shell !== "string" || d.shell.length) {
                        m.shell = $String(d.shell);
                    }
                }
                return m;
            };

            TermOpened.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.reqId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.reqId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.termId = "";
                    d.channel = 0;
                    d.title = "";
                    d.shell = "";
                }
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.reqId = typeof m.reqId === "number" ? $BigInt(m.reqId) : $util.Long.fromBits(m.reqId.low >>> 0, m.reqId.high >>> 0, true).toBigInt();
                    else if (typeof m.reqId === "number")
                        d.reqId = o.longs === $String ? $String(m.reqId) : m.reqId;
                    else
                        d.reqId = o.longs === $String ? $util.Long.prototype.toString.call(m.reqId) : o.longs === $Number ? new $util.LongBits(m.reqId.low >>> 0, m.reqId.high >>> 0).toNumber(true) : m.reqId;
                }
                if (m.termId != null && $Object.hasOwnProperty.call(m, "termId")) {
                    d.termId = m.termId;
                }
                if (m.channel != null && $Object.hasOwnProperty.call(m, "channel")) {
                    d.channel = m.channel;
                }
                if (m.title != null && $Object.hasOwnProperty.call(m, "title")) {
                    d.title = m.title;
                }
                if (m.shell != null && $Object.hasOwnProperty.call(m, "shell")) {
                    d.shell = m.shell;
                }
                return d;
            };

            TermOpened.prototype.toJSON = function() {
                return TermOpened.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermOpened.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermOpened";
            };

            return TermOpened;
        })();

        v1.TermList = (function() {

            const TermList = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermList.create = function(properties) {
                return new TermList(properties);
            };

            TermList.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermList.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermList();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    r.skipType(t & 7, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermList.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermList)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermList: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                return new $root.rterm.v1.TermList();
            };

            TermList.toObject = function () {
                return {};
            };

            TermList.prototype.toJSON = function() {
                return TermList.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermList.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermList";
            };

            return TermList;
        })();

        v1.TermListResp = (function() {

            const TermListResp = function (p) {
                this.terms = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermListResp.prototype.terms = $util.emptyArray;

            TermListResp.create = function(properties) {
                return new TermListResp(properties);
            };

            TermListResp.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.terms != null && m.terms.length) {
                    for (var i = 0; i < m.terms.length; ++i)
                        $root.rterm.v1.TermInfo.encode(m.terms[i], w.uint32(10).fork(), q + 1).ldelim();
                }
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermListResp.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermListResp();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if (!(m.terms && m.terms.length))
                                m.terms = [];
                            m.terms.push($root.rterm.v1.TermInfo.decode(r, r.size(), $undefined, q + 1));
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermListResp.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermListResp)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermListResp: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermListResp();
                if (d.terms) {
                    if (!$Array.isArray(d.terms))
                        throw $TypeError(".rterm.v1.TermListResp.terms: array expected");
                    m.terms = $Array(d.terms.length);
                    for (var i = 0; i < d.terms.length; ++i) {
                        if (!$util.isObject(d.terms[i]))
                            throw $TypeError(".rterm.v1.TermListResp.terms: object expected");
                        m.terms[i] = $root.rterm.v1.TermInfo.fromObject(d.terms[i], q + 1);
                    }
                }
                return m;
            };

            TermListResp.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.terms = [];
                }
                if (m.terms && m.terms.length) {
                    d.terms = $Array(m.terms.length);
                    for (var j = 0; j < m.terms.length; ++j) {
                        d.terms[j] = $root.rterm.v1.TermInfo.toObject(m.terms[j], o, q + 1);
                    }
                }
                return d;
            };

            TermListResp.prototype.toJSON = function() {
                return TermListResp.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermListResp.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermListResp";
            };

            return TermListResp;
        })();

        v1.TermInfo = (function() {

            const TermInfo = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermInfo.prototype.termId = "";
            TermInfo.prototype.title = "";
            TermInfo.prototype.profile = 0;
            TermInfo.prototype.cwd = "";
            TermInfo.prototype.createdAt = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermInfo.prototype.lastSeq = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermInfo.prototype.exited = false;
            TermInfo.prototype.attached = false;
            TermInfo.prototype.channel = 0;
            TermInfo.prototype.attachedByOther = false;

            TermInfo.create = function(properties) {
                return new TermInfo(properties);
            };

            TermInfo.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.termId != null && $Object.hasOwnProperty.call(m, "termId") && m.termId !== "")
                    w.uint32(10).string(m.termId);
                if (m.title != null && $Object.hasOwnProperty.call(m, "title") && m.title !== "")
                    w.uint32(18).string(m.title);
                if (m.profile != null && $Object.hasOwnProperty.call(m, "profile") && m.profile !== 0)
                    w.uint32(24).int32(m.profile);
                if (m.cwd != null && $Object.hasOwnProperty.call(m, "cwd") && m.cwd !== "")
                    w.uint32(34).string(m.cwd);
                if (m.createdAt != null && $Object.hasOwnProperty.call(m, "createdAt") && (typeof m.createdAt === "object" ? m.createdAt.low || m.createdAt.high : m.createdAt !== 0))
                    w.uint32(40).uint64(m.createdAt);
                if (m.lastSeq != null && $Object.hasOwnProperty.call(m, "lastSeq") && (typeof m.lastSeq === "object" ? m.lastSeq.low || m.lastSeq.high : m.lastSeq !== 0))
                    w.uint32(48).uint64(m.lastSeq);
                if (m.exited != null && $Object.hasOwnProperty.call(m, "exited") && m.exited !== false)
                    w.uint32(56).bool(m.exited);
                if (m.attached != null && $Object.hasOwnProperty.call(m, "attached") && m.attached !== false)
                    w.uint32(64).bool(m.attached);
                if (m.channel != null && $Object.hasOwnProperty.call(m, "channel") && m.channel !== 0)
                    w.uint32(72).uint32(m.channel);
                if (m.attachedByOther != null && $Object.hasOwnProperty.call(m, "attachedByOther") && m.attachedByOther !== false)
                    w.uint32(80).bool(m.attachedByOther);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermInfo.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermInfo();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.termId = v;
                            else
                                delete m.termId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.title = v;
                            else
                                delete m.title;
                            continue;
                        }
                    case 3: {
                            if (u !== 0)
                                break;
                            if (v = r.int32())
                                m.profile = v;
                            else
                                delete m.profile;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.cwd = v;
                            else
                                delete m.cwd;
                            continue;
                        }
                    case 5: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.createdAt = v;
                            else
                                delete m.createdAt;
                            continue;
                        }
                    case 6: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.lastSeq = v;
                            else
                                delete m.lastSeq;
                            continue;
                        }
                    case 7: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.exited = v;
                            else
                                delete m.exited;
                            continue;
                        }
                    case 8: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.attached = v;
                            else
                                delete m.attached;
                            continue;
                        }
                    case 9: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.channel = v;
                            else
                                delete m.channel;
                            continue;
                        }
                    case 10: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.attachedByOther = v;
                            else
                                delete m.attachedByOther;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermInfo.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermInfo)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermInfo: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermInfo();
                if (d.termId != null) {
                    if (typeof d.termId !== "string" || d.termId.length) {
                        m.termId = $String(d.termId);
                    }
                }
                if (d.title != null) {
                    if (typeof d.title !== "string" || d.title.length) {
                        m.title = $String(d.title);
                    }
                }
                if (d.profile !== 0 && (typeof d.profile !== "string" || $root.rterm.v1.Profile[d.profile] !== 0)) {
                    switch (d.profile) {
                    case "PROFILE_SHELL":
                    case 0:
                        m.profile = 0;
                        break;
                    case "PROFILE_CLAUDE":
                    case 1:
                        m.profile = 1;
                        break;
                    case "PROFILE_CUSTOM":
                    case 2:
                        m.profile = 2;
                        break;
                    default:
                        if (typeof d.profile === "number" && (d.profile | 0) === d.profile)
                            m.profile = d.profile;
                    }
                }
                if (d.cwd != null) {
                    if (typeof d.cwd !== "string" || d.cwd.length) {
                        m.cwd = $String(d.cwd);
                    }
                }
                if (d.createdAt != null) {
                    if (typeof d.createdAt === "object" ? d.createdAt.low || d.createdAt.high : $Number(d.createdAt) !== 0) {
                        if ($util.Long)
                            m.createdAt = $util.Long.fromValue(d.createdAt, true);
                        else if (typeof d.createdAt === "string")
                            m.createdAt = $parseInt(d.createdAt, 10);
                        else if (typeof d.createdAt === "number")
                            m.createdAt = d.createdAt;
                        else if (typeof d.createdAt === "object")
                            m.createdAt = new $util.LongBits(d.createdAt.low >>> 0, d.createdAt.high >>> 0).toNumber(true);
                    }
                }
                if (d.lastSeq != null) {
                    if (typeof d.lastSeq === "object" ? d.lastSeq.low || d.lastSeq.high : $Number(d.lastSeq) !== 0) {
                        if ($util.Long)
                            m.lastSeq = $util.Long.fromValue(d.lastSeq, true);
                        else if (typeof d.lastSeq === "string")
                            m.lastSeq = $parseInt(d.lastSeq, 10);
                        else if (typeof d.lastSeq === "number")
                            m.lastSeq = d.lastSeq;
                        else if (typeof d.lastSeq === "object")
                            m.lastSeq = new $util.LongBits(d.lastSeq.low >>> 0, d.lastSeq.high >>> 0).toNumber(true);
                    }
                }
                if (d.exited != null) {
                    if (d.exited) {
                        m.exited = $Boolean(d.exited);
                    }
                }
                if (d.attached != null) {
                    if (d.attached) {
                        m.attached = $Boolean(d.attached);
                    }
                }
                if (d.channel != null) {
                    if ($Number(d.channel) !== 0) {
                        m.channel = d.channel >>> 0;
                    }
                }
                if (d.attachedByOther != null) {
                    if (d.attachedByOther) {
                        m.attachedByOther = $Boolean(d.attachedByOther);
                    }
                }
                return m;
            };

            TermInfo.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.termId = "";
                    d.title = "";
                    d.profile = o.enums === $String ? "PROFILE_SHELL" : 0;
                    d.cwd = "";
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.createdAt = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.createdAt = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.lastSeq = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.lastSeq = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.exited = false;
                    d.attached = false;
                    d.channel = 0;
                    d.attachedByOther = false;
                }
                if (m.termId != null && $Object.hasOwnProperty.call(m, "termId")) {
                    d.termId = m.termId;
                }
                if (m.title != null && $Object.hasOwnProperty.call(m, "title")) {
                    d.title = m.title;
                }
                if (m.profile != null && $Object.hasOwnProperty.call(m, "profile")) {
                    d.profile = o.enums === $String ? $root.rterm.v1.Profile[m.profile] === $undefined ? m.profile : $root.rterm.v1.Profile[m.profile] : m.profile;
                }
                if (m.cwd != null && $Object.hasOwnProperty.call(m, "cwd")) {
                    d.cwd = m.cwd;
                }
                if (m.createdAt != null && $Object.hasOwnProperty.call(m, "createdAt")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.createdAt = typeof m.createdAt === "number" ? $BigInt(m.createdAt) : $util.Long.fromBits(m.createdAt.low >>> 0, m.createdAt.high >>> 0, true).toBigInt();
                    else if (typeof m.createdAt === "number")
                        d.createdAt = o.longs === $String ? $String(m.createdAt) : m.createdAt;
                    else
                        d.createdAt = o.longs === $String ? $util.Long.prototype.toString.call(m.createdAt) : o.longs === $Number ? new $util.LongBits(m.createdAt.low >>> 0, m.createdAt.high >>> 0).toNumber(true) : m.createdAt;
                }
                if (m.lastSeq != null && $Object.hasOwnProperty.call(m, "lastSeq")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.lastSeq = typeof m.lastSeq === "number" ? $BigInt(m.lastSeq) : $util.Long.fromBits(m.lastSeq.low >>> 0, m.lastSeq.high >>> 0, true).toBigInt();
                    else if (typeof m.lastSeq === "number")
                        d.lastSeq = o.longs === $String ? $String(m.lastSeq) : m.lastSeq;
                    else
                        d.lastSeq = o.longs === $String ? $util.Long.prototype.toString.call(m.lastSeq) : o.longs === $Number ? new $util.LongBits(m.lastSeq.low >>> 0, m.lastSeq.high >>> 0).toNumber(true) : m.lastSeq;
                }
                if (m.exited != null && $Object.hasOwnProperty.call(m, "exited")) {
                    d.exited = m.exited;
                }
                if (m.attached != null && $Object.hasOwnProperty.call(m, "attached")) {
                    d.attached = m.attached;
                }
                if (m.channel != null && $Object.hasOwnProperty.call(m, "channel")) {
                    d.channel = m.channel;
                }
                if (m.attachedByOther != null && $Object.hasOwnProperty.call(m, "attachedByOther")) {
                    d.attachedByOther = m.attachedByOther;
                }
                return d;
            };

            TermInfo.prototype.toJSON = function() {
                return TermInfo.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermInfo.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermInfo";
            };

            return TermInfo;
        })();

        v1.TermAttach = (function() {

            const TermAttach = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermAttach.prototype.reqId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermAttach.prototype.termId = "";
            TermAttach.prototype.lastSeq = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermAttach.prototype.cols = 0;
            TermAttach.prototype.rows = 0;

            TermAttach.create = function(properties) {
                return new TermAttach(properties);
            };

            TermAttach.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId") && (typeof m.reqId === "object" ? m.reqId.low || m.reqId.high : m.reqId !== 0))
                    w.uint32(8).uint64(m.reqId);
                if (m.termId != null && $Object.hasOwnProperty.call(m, "termId") && m.termId !== "")
                    w.uint32(18).string(m.termId);
                if (m.lastSeq != null && $Object.hasOwnProperty.call(m, "lastSeq") && (typeof m.lastSeq === "object" ? m.lastSeq.low || m.lastSeq.high : m.lastSeq !== 0))
                    w.uint32(24).uint64(m.lastSeq);
                if (m.cols != null && $Object.hasOwnProperty.call(m, "cols") && m.cols !== 0)
                    w.uint32(32).uint32(m.cols);
                if (m.rows != null && $Object.hasOwnProperty.call(m, "rows") && m.rows !== 0)
                    w.uint32(40).uint32(m.rows);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermAttach.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermAttach();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.reqId = v;
                            else
                                delete m.reqId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.termId = v;
                            else
                                delete m.termId;
                            continue;
                        }
                    case 3: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.lastSeq = v;
                            else
                                delete m.lastSeq;
                            continue;
                        }
                    case 4: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.cols = v;
                            else
                                delete m.cols;
                            continue;
                        }
                    case 5: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.rows = v;
                            else
                                delete m.rows;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermAttach.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermAttach)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermAttach: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermAttach();
                if (d.reqId != null) {
                    if (typeof d.reqId === "object" ? d.reqId.low || d.reqId.high : $Number(d.reqId) !== 0) {
                        if ($util.Long)
                            m.reqId = $util.Long.fromValue(d.reqId, true);
                        else if (typeof d.reqId === "string")
                            m.reqId = $parseInt(d.reqId, 10);
                        else if (typeof d.reqId === "number")
                            m.reqId = d.reqId;
                        else if (typeof d.reqId === "object")
                            m.reqId = new $util.LongBits(d.reqId.low >>> 0, d.reqId.high >>> 0).toNumber(true);
                    }
                }
                if (d.termId != null) {
                    if (typeof d.termId !== "string" || d.termId.length) {
                        m.termId = $String(d.termId);
                    }
                }
                if (d.lastSeq != null) {
                    if (typeof d.lastSeq === "object" ? d.lastSeq.low || d.lastSeq.high : $Number(d.lastSeq) !== 0) {
                        if ($util.Long)
                            m.lastSeq = $util.Long.fromValue(d.lastSeq, true);
                        else if (typeof d.lastSeq === "string")
                            m.lastSeq = $parseInt(d.lastSeq, 10);
                        else if (typeof d.lastSeq === "number")
                            m.lastSeq = d.lastSeq;
                        else if (typeof d.lastSeq === "object")
                            m.lastSeq = new $util.LongBits(d.lastSeq.low >>> 0, d.lastSeq.high >>> 0).toNumber(true);
                    }
                }
                if (d.cols != null) {
                    if ($Number(d.cols) !== 0) {
                        m.cols = d.cols >>> 0;
                    }
                }
                if (d.rows != null) {
                    if ($Number(d.rows) !== 0) {
                        m.rows = d.rows >>> 0;
                    }
                }
                return m;
            };

            TermAttach.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.reqId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.reqId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.termId = "";
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.lastSeq = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.lastSeq = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.cols = 0;
                    d.rows = 0;
                }
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.reqId = typeof m.reqId === "number" ? $BigInt(m.reqId) : $util.Long.fromBits(m.reqId.low >>> 0, m.reqId.high >>> 0, true).toBigInt();
                    else if (typeof m.reqId === "number")
                        d.reqId = o.longs === $String ? $String(m.reqId) : m.reqId;
                    else
                        d.reqId = o.longs === $String ? $util.Long.prototype.toString.call(m.reqId) : o.longs === $Number ? new $util.LongBits(m.reqId.low >>> 0, m.reqId.high >>> 0).toNumber(true) : m.reqId;
                }
                if (m.termId != null && $Object.hasOwnProperty.call(m, "termId")) {
                    d.termId = m.termId;
                }
                if (m.lastSeq != null && $Object.hasOwnProperty.call(m, "lastSeq")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.lastSeq = typeof m.lastSeq === "number" ? $BigInt(m.lastSeq) : $util.Long.fromBits(m.lastSeq.low >>> 0, m.lastSeq.high >>> 0, true).toBigInt();
                    else if (typeof m.lastSeq === "number")
                        d.lastSeq = o.longs === $String ? $String(m.lastSeq) : m.lastSeq;
                    else
                        d.lastSeq = o.longs === $String ? $util.Long.prototype.toString.call(m.lastSeq) : o.longs === $Number ? new $util.LongBits(m.lastSeq.low >>> 0, m.lastSeq.high >>> 0).toNumber(true) : m.lastSeq;
                }
                if (m.cols != null && $Object.hasOwnProperty.call(m, "cols")) {
                    d.cols = m.cols;
                }
                if (m.rows != null && $Object.hasOwnProperty.call(m, "rows")) {
                    d.rows = m.rows;
                }
                return d;
            };

            TermAttach.prototype.toJSON = function() {
                return TermAttach.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermAttach.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermAttach";
            };

            return TermAttach;
        })();

        v1.TermClose = (function() {

            const TermClose = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermClose.prototype.termId = "";
            TermClose.prototype.kill = false;

            TermClose.create = function(properties) {
                return new TermClose(properties);
            };

            TermClose.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.termId != null && $Object.hasOwnProperty.call(m, "termId") && m.termId !== "")
                    w.uint32(10).string(m.termId);
                if (m.kill != null && $Object.hasOwnProperty.call(m, "kill") && m.kill !== false)
                    w.uint32(16).bool(m.kill);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermClose.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermClose();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.termId = v;
                            else
                                delete m.termId;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.kill = v;
                            else
                                delete m.kill;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermClose.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermClose)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermClose: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermClose();
                if (d.termId != null) {
                    if (typeof d.termId !== "string" || d.termId.length) {
                        m.termId = $String(d.termId);
                    }
                }
                if (d.kill != null) {
                    if (d.kill) {
                        m.kill = $Boolean(d.kill);
                    }
                }
                return m;
            };

            TermClose.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.termId = "";
                    d.kill = false;
                }
                if (m.termId != null && $Object.hasOwnProperty.call(m, "termId")) {
                    d.termId = m.termId;
                }
                if (m.kill != null && $Object.hasOwnProperty.call(m, "kill")) {
                    d.kill = m.kill;
                }
                return d;
            };

            TermClose.prototype.toJSON = function() {
                return TermClose.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermClose.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermClose";
            };

            return TermClose;
        })();

        v1.TermOutput = (function() {

            const TermOutput = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermOutput.prototype.seq = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermOutput.prototype.data = $util.newBuffer([]);

            TermOutput.create = function(properties) {
                return new TermOutput(properties);
            };

            TermOutput.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.seq != null && $Object.hasOwnProperty.call(m, "seq") && (typeof m.seq === "object" ? m.seq.low || m.seq.high : m.seq !== 0))
                    w.uint32(8).uint64(m.seq);
                if (m.data != null && $Object.hasOwnProperty.call(m, "data") && m.data.length)
                    w.uint32(18).bytes(m.data);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermOutput.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermOutput();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.seq = v;
                            else
                                delete m.seq;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.data = v;
                            else
                                delete m.data;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermOutput.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermOutput)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermOutput: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermOutput();
                if (d.seq != null) {
                    if (typeof d.seq === "object" ? d.seq.low || d.seq.high : $Number(d.seq) !== 0) {
                        if ($util.Long)
                            m.seq = $util.Long.fromValue(d.seq, true);
                        else if (typeof d.seq === "string")
                            m.seq = $parseInt(d.seq, 10);
                        else if (typeof d.seq === "number")
                            m.seq = d.seq;
                        else if (typeof d.seq === "object")
                            m.seq = new $util.LongBits(d.seq.low >>> 0, d.seq.high >>> 0).toNumber(true);
                    }
                }
                if (d.data != null) {
                    if (d.data.length) {
                        if (typeof d.data === "string")
                            $util.base64.decode(d.data, m.data = $util.newBuffer($util.base64.length(d.data)), 0);
                        else if (d.data.length >= 0)
                            m.data = d.data;
                    }
                }
                return m;
            };

            TermOutput.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.seq = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.seq = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    if (o.bytes === $String)
                        d.data = "";
                    else {
                        d.data = [];
                        if (o.bytes !== $Array)
                            d.data = $util.newBuffer(d.data);
                    }
                }
                if (m.seq != null && $Object.hasOwnProperty.call(m, "seq")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.seq = typeof m.seq === "number" ? $BigInt(m.seq) : $util.Long.fromBits(m.seq.low >>> 0, m.seq.high >>> 0, true).toBigInt();
                    else if (typeof m.seq === "number")
                        d.seq = o.longs === $String ? $String(m.seq) : m.seq;
                    else
                        d.seq = o.longs === $String ? $util.Long.prototype.toString.call(m.seq) : o.longs === $Number ? new $util.LongBits(m.seq.low >>> 0, m.seq.high >>> 0).toNumber(true) : m.seq;
                }
                if (m.data != null && $Object.hasOwnProperty.call(m, "data")) {
                    d.data = o.bytes === $String ? $util.base64.encode(m.data, 0, m.data.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.data) : m.data;
                }
                return d;
            };

            TermOutput.prototype.toJSON = function() {
                return TermOutput.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermOutput.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermOutput";
            };

            return TermOutput;
        })();

        v1.TermInput = (function() {

            const TermInput = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermInput.prototype.data = $util.newBuffer([]);

            TermInput.create = function(properties) {
                return new TermInput(properties);
            };

            TermInput.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.data != null && $Object.hasOwnProperty.call(m, "data") && m.data.length)
                    w.uint32(10).bytes(m.data);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermInput.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermInput();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.data = v;
                            else
                                delete m.data;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermInput.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermInput)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermInput: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermInput();
                if (d.data != null) {
                    if (d.data.length) {
                        if (typeof d.data === "string")
                            $util.base64.decode(d.data, m.data = $util.newBuffer($util.base64.length(d.data)), 0);
                        else if (d.data.length >= 0)
                            m.data = d.data;
                    }
                }
                return m;
            };

            TermInput.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if (o.bytes === $String)
                        d.data = "";
                    else {
                        d.data = [];
                        if (o.bytes !== $Array)
                            d.data = $util.newBuffer(d.data);
                    }
                }
                if (m.data != null && $Object.hasOwnProperty.call(m, "data")) {
                    d.data = o.bytes === $String ? $util.base64.encode(m.data, 0, m.data.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.data) : m.data;
                }
                return d;
            };

            TermInput.prototype.toJSON = function() {
                return TermInput.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermInput.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermInput";
            };

            return TermInput;
        })();

        v1.TermSubmit = (function() {

            const TermSubmit = function (p) {
                this.attachments = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermSubmit.prototype.msgId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermSubmit.prototype.text = "";
            TermSubmit.prototype.attachments = $util.emptyArray;
            TermSubmit.prototype.pressEnter = false;

            TermSubmit.create = function(properties) {
                return new TermSubmit(properties);
            };

            TermSubmit.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.msgId != null && $Object.hasOwnProperty.call(m, "msgId") && (typeof m.msgId === "object" ? m.msgId.low || m.msgId.high : m.msgId !== 0))
                    w.uint32(8).uint64(m.msgId);
                if (m.text != null && $Object.hasOwnProperty.call(m, "text") && m.text !== "")
                    w.uint32(18).string(m.text);
                if (m.attachments != null && m.attachments.length) {
                    w.uint32(26).uint64s(m.attachments);
                }
                if (m.pressEnter != null && $Object.hasOwnProperty.call(m, "pressEnter") && m.pressEnter !== false)
                    w.uint32(32).bool(m.pressEnter);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermSubmit.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermSubmit();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.msgId = v;
                            else
                                delete m.msgId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.text = v;
                            else
                                delete m.text;
                            continue;
                        }
                    case 3: {
                            if (u === 2) {
                                if (!(m.attachments && m.attachments.length))
                                    m.attachments = [];
                                r.uint64s(m.attachments);
                                continue;
                            }
                            if (u !== 0)
                                break;
                            if (!(m.attachments && m.attachments.length))
                                m.attachments = [];
                            m.attachments.push(r.uint64());
                            continue;
                        }
                    case 4: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.pressEnter = v;
                            else
                                delete m.pressEnter;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermSubmit.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermSubmit)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermSubmit: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermSubmit();
                if (d.msgId != null) {
                    if (typeof d.msgId === "object" ? d.msgId.low || d.msgId.high : $Number(d.msgId) !== 0) {
                        if ($util.Long)
                            m.msgId = $util.Long.fromValue(d.msgId, true);
                        else if (typeof d.msgId === "string")
                            m.msgId = $parseInt(d.msgId, 10);
                        else if (typeof d.msgId === "number")
                            m.msgId = d.msgId;
                        else if (typeof d.msgId === "object")
                            m.msgId = new $util.LongBits(d.msgId.low >>> 0, d.msgId.high >>> 0).toNumber(true);
                    }
                }
                if (d.text != null) {
                    if (typeof d.text !== "string" || d.text.length) {
                        m.text = $String(d.text);
                    }
                }
                if (d.attachments) {
                    if (!$Array.isArray(d.attachments))
                        throw $TypeError(".rterm.v1.TermSubmit.attachments: array expected");
                    m.attachments = $Array(d.attachments.length);
                    for (var i = 0; i < d.attachments.length; ++i) {
                        if ($util.Long)
                            m.attachments[i] = $util.Long.fromValue(d.attachments[i], true);
                        else if (typeof d.attachments[i] === "string")
                            m.attachments[i] = $parseInt(d.attachments[i], 10);
                        else if (typeof d.attachments[i] === "number")
                            m.attachments[i] = d.attachments[i];
                        else if (typeof d.attachments[i] === "object")
                            m.attachments[i] = new $util.LongBits(d.attachments[i].low >>> 0, d.attachments[i].high >>> 0).toNumber(true);
                    }
                }
                if (d.pressEnter != null) {
                    if (d.pressEnter) {
                        m.pressEnter = $Boolean(d.pressEnter);
                    }
                }
                return m;
            };

            TermSubmit.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.attachments = [];
                }
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.msgId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.msgId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.text = "";
                    d.pressEnter = false;
                }
                if (m.msgId != null && $Object.hasOwnProperty.call(m, "msgId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.msgId = typeof m.msgId === "number" ? $BigInt(m.msgId) : $util.Long.fromBits(m.msgId.low >>> 0, m.msgId.high >>> 0, true).toBigInt();
                    else if (typeof m.msgId === "number")
                        d.msgId = o.longs === $String ? $String(m.msgId) : m.msgId;
                    else
                        d.msgId = o.longs === $String ? $util.Long.prototype.toString.call(m.msgId) : o.longs === $Number ? new $util.LongBits(m.msgId.low >>> 0, m.msgId.high >>> 0).toNumber(true) : m.msgId;
                }
                if (m.text != null && $Object.hasOwnProperty.call(m, "text")) {
                    d.text = m.text;
                }
                if (m.attachments && m.attachments.length) {
                    d.attachments = $Array(m.attachments.length);
                    for (var j = 0; j < m.attachments.length; ++j) {
                        if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                            d.attachments[j] = typeof m.attachments[j] === "number" ? $BigInt(m.attachments[j]) : $util.Long.fromBits(m.attachments[j].low >>> 0, m.attachments[j].high >>> 0, true).toBigInt();
                        else if (typeof m.attachments[j] === "number")
                            d.attachments[j] = o.longs === $String ? $String(m.attachments[j]) : m.attachments[j];
                        else
                            d.attachments[j] = o.longs === $String ? $util.Long.prototype.toString.call(m.attachments[j]) : o.longs === $Number ? new $util.LongBits(m.attachments[j].low >>> 0, m.attachments[j].high >>> 0).toNumber(true) : m.attachments[j];
                    }
                }
                if (m.pressEnter != null && $Object.hasOwnProperty.call(m, "pressEnter")) {
                    d.pressEnter = m.pressEnter;
                }
                return d;
            };

            TermSubmit.prototype.toJSON = function() {
                return TermSubmit.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermSubmit.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermSubmit";
            };

            return TermSubmit;
        })();

        v1.TermResize = (function() {

            const TermResize = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermResize.prototype.cols = 0;
            TermResize.prototype.rows = 0;

            TermResize.create = function(properties) {
                return new TermResize(properties);
            };

            TermResize.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.cols != null && $Object.hasOwnProperty.call(m, "cols") && m.cols !== 0)
                    w.uint32(8).uint32(m.cols);
                if (m.rows != null && $Object.hasOwnProperty.call(m, "rows") && m.rows !== 0)
                    w.uint32(16).uint32(m.rows);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermResize.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermResize();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.cols = v;
                            else
                                delete m.cols;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.rows = v;
                            else
                                delete m.rows;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermResize.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermResize)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermResize: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermResize();
                if (d.cols != null) {
                    if ($Number(d.cols) !== 0) {
                        m.cols = d.cols >>> 0;
                    }
                }
                if (d.rows != null) {
                    if ($Number(d.rows) !== 0) {
                        m.rows = d.rows >>> 0;
                    }
                }
                return m;
            };

            TermResize.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.cols = 0;
                    d.rows = 0;
                }
                if (m.cols != null && $Object.hasOwnProperty.call(m, "cols")) {
                    d.cols = m.cols;
                }
                if (m.rows != null && $Object.hasOwnProperty.call(m, "rows")) {
                    d.rows = m.rows;
                }
                return d;
            };

            TermResize.prototype.toJSON = function() {
                return TermResize.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermResize.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermResize";
            };

            return TermResize;
        })();

        v1.TermAck = (function() {

            const TermAck = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermAck.prototype.consumed = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

            TermAck.create = function(properties) {
                return new TermAck(properties);
            };

            TermAck.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.consumed != null && $Object.hasOwnProperty.call(m, "consumed") && (typeof m.consumed === "object" ? m.consumed.low || m.consumed.high : m.consumed !== 0))
                    w.uint32(8).uint64(m.consumed);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermAck.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermAck();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.consumed = v;
                            else
                                delete m.consumed;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermAck.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermAck)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermAck: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermAck();
                if (d.consumed != null) {
                    if (typeof d.consumed === "object" ? d.consumed.low || d.consumed.high : $Number(d.consumed) !== 0) {
                        if ($util.Long)
                            m.consumed = $util.Long.fromValue(d.consumed, true);
                        else if (typeof d.consumed === "string")
                            m.consumed = $parseInt(d.consumed, 10);
                        else if (typeof d.consumed === "number")
                            m.consumed = d.consumed;
                        else if (typeof d.consumed === "object")
                            m.consumed = new $util.LongBits(d.consumed.low >>> 0, d.consumed.high >>> 0).toNumber(true);
                    }
                }
                return m;
            };

            TermAck.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.consumed = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.consumed = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                }
                if (m.consumed != null && $Object.hasOwnProperty.call(m, "consumed")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.consumed = typeof m.consumed === "number" ? $BigInt(m.consumed) : $util.Long.fromBits(m.consumed.low >>> 0, m.consumed.high >>> 0, true).toBigInt();
                    else if (typeof m.consumed === "number")
                        d.consumed = o.longs === $String ? $String(m.consumed) : m.consumed;
                    else
                        d.consumed = o.longs === $String ? $util.Long.prototype.toString.call(m.consumed) : o.longs === $Number ? new $util.LongBits(m.consumed.low >>> 0, m.consumed.high >>> 0).toNumber(true) : m.consumed;
                }
                return d;
            };

            TermAck.prototype.toJSON = function() {
                return TermAck.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermAck.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermAck";
            };

            return TermAck;
        })();

        v1.TermState = (function() {

            const TermState = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermState.prototype.bracketedPaste = false;
            TermState.prototype.altScreen = false;
            TermState.prototype.appCursor = false;
            TermState.prototype.mouse = false;
            TermState.prototype.title = "";

            TermState.create = function(properties) {
                return new TermState(properties);
            };

            TermState.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.bracketedPaste != null && $Object.hasOwnProperty.call(m, "bracketedPaste") && m.bracketedPaste !== false)
                    w.uint32(8).bool(m.bracketedPaste);
                if (m.altScreen != null && $Object.hasOwnProperty.call(m, "altScreen") && m.altScreen !== false)
                    w.uint32(16).bool(m.altScreen);
                if (m.appCursor != null && $Object.hasOwnProperty.call(m, "appCursor") && m.appCursor !== false)
                    w.uint32(24).bool(m.appCursor);
                if (m.mouse != null && $Object.hasOwnProperty.call(m, "mouse") && m.mouse !== false)
                    w.uint32(32).bool(m.mouse);
                if (m.title != null && $Object.hasOwnProperty.call(m, "title") && m.title !== "")
                    w.uint32(42).string(m.title);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermState.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermState();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.bracketedPaste = v;
                            else
                                delete m.bracketedPaste;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.altScreen = v;
                            else
                                delete m.altScreen;
                            continue;
                        }
                    case 3: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.appCursor = v;
                            else
                                delete m.appCursor;
                            continue;
                        }
                    case 4: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.mouse = v;
                            else
                                delete m.mouse;
                            continue;
                        }
                    case 5: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.title = v;
                            else
                                delete m.title;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermState.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermState)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermState: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermState();
                if (d.bracketedPaste != null) {
                    if (d.bracketedPaste) {
                        m.bracketedPaste = $Boolean(d.bracketedPaste);
                    }
                }
                if (d.altScreen != null) {
                    if (d.altScreen) {
                        m.altScreen = $Boolean(d.altScreen);
                    }
                }
                if (d.appCursor != null) {
                    if (d.appCursor) {
                        m.appCursor = $Boolean(d.appCursor);
                    }
                }
                if (d.mouse != null) {
                    if (d.mouse) {
                        m.mouse = $Boolean(d.mouse);
                    }
                }
                if (d.title != null) {
                    if (typeof d.title !== "string" || d.title.length) {
                        m.title = $String(d.title);
                    }
                }
                return m;
            };

            TermState.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.bracketedPaste = false;
                    d.altScreen = false;
                    d.appCursor = false;
                    d.mouse = false;
                    d.title = "";
                }
                if (m.bracketedPaste != null && $Object.hasOwnProperty.call(m, "bracketedPaste")) {
                    d.bracketedPaste = m.bracketedPaste;
                }
                if (m.altScreen != null && $Object.hasOwnProperty.call(m, "altScreen")) {
                    d.altScreen = m.altScreen;
                }
                if (m.appCursor != null && $Object.hasOwnProperty.call(m, "appCursor")) {
                    d.appCursor = m.appCursor;
                }
                if (m.mouse != null && $Object.hasOwnProperty.call(m, "mouse")) {
                    d.mouse = m.mouse;
                }
                if (m.title != null && $Object.hasOwnProperty.call(m, "title")) {
                    d.title = m.title;
                }
                return d;
            };

            TermState.prototype.toJSON = function() {
                return TermState.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermState.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermState";
            };

            return TermState;
        })();

        v1.TermExit = (function() {

            const TermExit = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermExit.prototype.code = 0;

            TermExit.create = function(properties) {
                return new TermExit(properties);
            };

            TermExit.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.code != null && $Object.hasOwnProperty.call(m, "code") && m.code !== 0)
                    w.uint32(8).int32(m.code);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermExit.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermExit();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (v = r.int32())
                                m.code = v;
                            else
                                delete m.code;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermExit.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermExit)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermExit: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermExit();
                if (d.code != null) {
                    if ($Number(d.code) !== 0) {
                        m.code = d.code | 0;
                    }
                }
                return m;
            };

            TermExit.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.code = 0;
                }
                if (m.code != null && $Object.hasOwnProperty.call(m, "code")) {
                    d.code = m.code;
                }
                return d;
            };

            TermExit.prototype.toJSON = function() {
                return TermExit.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermExit.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermExit";
            };

            return TermExit;
        })();

        v1.FileBegin = (function() {

            const FileBegin = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            FileBegin.prototype.fileId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            FileBegin.prototype.name = "";
            FileBegin.prototype.size = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            FileBegin.prototype.mime = "";

            FileBegin.create = function(properties) {
                return new FileBegin(properties);
            };

            FileBegin.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId") && (typeof m.fileId === "object" ? m.fileId.low || m.fileId.high : m.fileId !== 0))
                    w.uint32(8).uint64(m.fileId);
                if (m.name != null && $Object.hasOwnProperty.call(m, "name") && m.name !== "")
                    w.uint32(18).string(m.name);
                if (m.size != null && $Object.hasOwnProperty.call(m, "size") && (typeof m.size === "object" ? m.size.low || m.size.high : m.size !== 0))
                    w.uint32(24).uint64(m.size);
                if (m.mime != null && $Object.hasOwnProperty.call(m, "mime") && m.mime !== "")
                    w.uint32(34).string(m.mime);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            FileBegin.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.FileBegin();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.fileId = v;
                            else
                                delete m.fileId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.name = v;
                            else
                                delete m.name;
                            continue;
                        }
                    case 3: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.size = v;
                            else
                                delete m.size;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.mime = v;
                            else
                                delete m.mime;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            FileBegin.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.FileBegin)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.FileBegin: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.FileBegin();
                if (d.fileId != null) {
                    if (typeof d.fileId === "object" ? d.fileId.low || d.fileId.high : $Number(d.fileId) !== 0) {
                        if ($util.Long)
                            m.fileId = $util.Long.fromValue(d.fileId, true);
                        else if (typeof d.fileId === "string")
                            m.fileId = $parseInt(d.fileId, 10);
                        else if (typeof d.fileId === "number")
                            m.fileId = d.fileId;
                        else if (typeof d.fileId === "object")
                            m.fileId = new $util.LongBits(d.fileId.low >>> 0, d.fileId.high >>> 0).toNumber(true);
                    }
                }
                if (d.name != null) {
                    if (typeof d.name !== "string" || d.name.length) {
                        m.name = $String(d.name);
                    }
                }
                if (d.size != null) {
                    if (typeof d.size === "object" ? d.size.low || d.size.high : $Number(d.size) !== 0) {
                        if ($util.Long)
                            m.size = $util.Long.fromValue(d.size, true);
                        else if (typeof d.size === "string")
                            m.size = $parseInt(d.size, 10);
                        else if (typeof d.size === "number")
                            m.size = d.size;
                        else if (typeof d.size === "object")
                            m.size = new $util.LongBits(d.size.low >>> 0, d.size.high >>> 0).toNumber(true);
                    }
                }
                if (d.mime != null) {
                    if (typeof d.mime !== "string" || d.mime.length) {
                        m.mime = $String(d.mime);
                    }
                }
                return m;
            };

            FileBegin.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.fileId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.fileId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.name = "";
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.size = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.size = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.mime = "";
                }
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.fileId = typeof m.fileId === "number" ? $BigInt(m.fileId) : $util.Long.fromBits(m.fileId.low >>> 0, m.fileId.high >>> 0, true).toBigInt();
                    else if (typeof m.fileId === "number")
                        d.fileId = o.longs === $String ? $String(m.fileId) : m.fileId;
                    else
                        d.fileId = o.longs === $String ? $util.Long.prototype.toString.call(m.fileId) : o.longs === $Number ? new $util.LongBits(m.fileId.low >>> 0, m.fileId.high >>> 0).toNumber(true) : m.fileId;
                }
                if (m.name != null && $Object.hasOwnProperty.call(m, "name")) {
                    d.name = m.name;
                }
                if (m.size != null && $Object.hasOwnProperty.call(m, "size")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.size = typeof m.size === "number" ? $BigInt(m.size) : $util.Long.fromBits(m.size.low >>> 0, m.size.high >>> 0, true).toBigInt();
                    else if (typeof m.size === "number")
                        d.size = o.longs === $String ? $String(m.size) : m.size;
                    else
                        d.size = o.longs === $String ? $util.Long.prototype.toString.call(m.size) : o.longs === $Number ? new $util.LongBits(m.size.low >>> 0, m.size.high >>> 0).toNumber(true) : m.size;
                }
                if (m.mime != null && $Object.hasOwnProperty.call(m, "mime")) {
                    d.mime = m.mime;
                }
                return d;
            };

            FileBegin.prototype.toJSON = function() {
                return FileBegin.toObject(this, $protobuf.util.toJSONOptions);
            };

            FileBegin.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.FileBegin";
            };

            return FileBegin;
        })();

        v1.FileAccept = (function() {

            const FileAccept = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            FileAccept.prototype.fileId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

            FileAccept.create = function(properties) {
                return new FileAccept(properties);
            };

            FileAccept.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId") && (typeof m.fileId === "object" ? m.fileId.low || m.fileId.high : m.fileId !== 0))
                    w.uint32(8).uint64(m.fileId);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            FileAccept.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.FileAccept();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.fileId = v;
                            else
                                delete m.fileId;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            FileAccept.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.FileAccept)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.FileAccept: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.FileAccept();
                if (d.fileId != null) {
                    if (typeof d.fileId === "object" ? d.fileId.low || d.fileId.high : $Number(d.fileId) !== 0) {
                        if ($util.Long)
                            m.fileId = $util.Long.fromValue(d.fileId, true);
                        else if (typeof d.fileId === "string")
                            m.fileId = $parseInt(d.fileId, 10);
                        else if (typeof d.fileId === "number")
                            m.fileId = d.fileId;
                        else if (typeof d.fileId === "object")
                            m.fileId = new $util.LongBits(d.fileId.low >>> 0, d.fileId.high >>> 0).toNumber(true);
                    }
                }
                return m;
            };

            FileAccept.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.fileId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.fileId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                }
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.fileId = typeof m.fileId === "number" ? $BigInt(m.fileId) : $util.Long.fromBits(m.fileId.low >>> 0, m.fileId.high >>> 0, true).toBigInt();
                    else if (typeof m.fileId === "number")
                        d.fileId = o.longs === $String ? $String(m.fileId) : m.fileId;
                    else
                        d.fileId = o.longs === $String ? $util.Long.prototype.toString.call(m.fileId) : o.longs === $Number ? new $util.LongBits(m.fileId.low >>> 0, m.fileId.high >>> 0).toNumber(true) : m.fileId;
                }
                return d;
            };

            FileAccept.prototype.toJSON = function() {
                return FileAccept.toObject(this, $protobuf.util.toJSONOptions);
            };

            FileAccept.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.FileAccept";
            };

            return FileAccept;
        })();

        v1.FileChunk = (function() {

            const FileChunk = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            FileChunk.prototype.fileId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            FileChunk.prototype.offset = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            FileChunk.prototype.data = $util.newBuffer([]);

            FileChunk.create = function(properties) {
                return new FileChunk(properties);
            };

            FileChunk.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId") && (typeof m.fileId === "object" ? m.fileId.low || m.fileId.high : m.fileId !== 0))
                    w.uint32(8).uint64(m.fileId);
                if (m.offset != null && $Object.hasOwnProperty.call(m, "offset") && (typeof m.offset === "object" ? m.offset.low || m.offset.high : m.offset !== 0))
                    w.uint32(16).uint64(m.offset);
                if (m.data != null && $Object.hasOwnProperty.call(m, "data") && m.data.length)
                    w.uint32(26).bytes(m.data);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            FileChunk.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.FileChunk();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.fileId = v;
                            else
                                delete m.fileId;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.offset = v;
                            else
                                delete m.offset;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.data = v;
                            else
                                delete m.data;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            FileChunk.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.FileChunk)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.FileChunk: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.FileChunk();
                if (d.fileId != null) {
                    if (typeof d.fileId === "object" ? d.fileId.low || d.fileId.high : $Number(d.fileId) !== 0) {
                        if ($util.Long)
                            m.fileId = $util.Long.fromValue(d.fileId, true);
                        else if (typeof d.fileId === "string")
                            m.fileId = $parseInt(d.fileId, 10);
                        else if (typeof d.fileId === "number")
                            m.fileId = d.fileId;
                        else if (typeof d.fileId === "object")
                            m.fileId = new $util.LongBits(d.fileId.low >>> 0, d.fileId.high >>> 0).toNumber(true);
                    }
                }
                if (d.offset != null) {
                    if (typeof d.offset === "object" ? d.offset.low || d.offset.high : $Number(d.offset) !== 0) {
                        if ($util.Long)
                            m.offset = $util.Long.fromValue(d.offset, true);
                        else if (typeof d.offset === "string")
                            m.offset = $parseInt(d.offset, 10);
                        else if (typeof d.offset === "number")
                            m.offset = d.offset;
                        else if (typeof d.offset === "object")
                            m.offset = new $util.LongBits(d.offset.low >>> 0, d.offset.high >>> 0).toNumber(true);
                    }
                }
                if (d.data != null) {
                    if (d.data.length) {
                        if (typeof d.data === "string")
                            $util.base64.decode(d.data, m.data = $util.newBuffer($util.base64.length(d.data)), 0);
                        else if (d.data.length >= 0)
                            m.data = d.data;
                    }
                }
                return m;
            };

            FileChunk.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.fileId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.fileId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.offset = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.offset = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    if (o.bytes === $String)
                        d.data = "";
                    else {
                        d.data = [];
                        if (o.bytes !== $Array)
                            d.data = $util.newBuffer(d.data);
                    }
                }
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.fileId = typeof m.fileId === "number" ? $BigInt(m.fileId) : $util.Long.fromBits(m.fileId.low >>> 0, m.fileId.high >>> 0, true).toBigInt();
                    else if (typeof m.fileId === "number")
                        d.fileId = o.longs === $String ? $String(m.fileId) : m.fileId;
                    else
                        d.fileId = o.longs === $String ? $util.Long.prototype.toString.call(m.fileId) : o.longs === $Number ? new $util.LongBits(m.fileId.low >>> 0, m.fileId.high >>> 0).toNumber(true) : m.fileId;
                }
                if (m.offset != null && $Object.hasOwnProperty.call(m, "offset")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.offset = typeof m.offset === "number" ? $BigInt(m.offset) : $util.Long.fromBits(m.offset.low >>> 0, m.offset.high >>> 0, true).toBigInt();
                    else if (typeof m.offset === "number")
                        d.offset = o.longs === $String ? $String(m.offset) : m.offset;
                    else
                        d.offset = o.longs === $String ? $util.Long.prototype.toString.call(m.offset) : o.longs === $Number ? new $util.LongBits(m.offset.low >>> 0, m.offset.high >>> 0).toNumber(true) : m.offset;
                }
                if (m.data != null && $Object.hasOwnProperty.call(m, "data")) {
                    d.data = o.bytes === $String ? $util.base64.encode(m.data, 0, m.data.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.data) : m.data;
                }
                return d;
            };

            FileChunk.prototype.toJSON = function() {
                return FileChunk.toObject(this, $protobuf.util.toJSONOptions);
            };

            FileChunk.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.FileChunk";
            };

            return FileChunk;
        })();

        v1.FileAck = (function() {

            const FileAck = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            FileAck.prototype.fileId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            FileAck.prototype.received = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

            FileAck.create = function(properties) {
                return new FileAck(properties);
            };

            FileAck.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId") && (typeof m.fileId === "object" ? m.fileId.low || m.fileId.high : m.fileId !== 0))
                    w.uint32(8).uint64(m.fileId);
                if (m.received != null && $Object.hasOwnProperty.call(m, "received") && (typeof m.received === "object" ? m.received.low || m.received.high : m.received !== 0))
                    w.uint32(16).uint64(m.received);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            FileAck.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.FileAck();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.fileId = v;
                            else
                                delete m.fileId;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.received = v;
                            else
                                delete m.received;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            FileAck.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.FileAck)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.FileAck: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.FileAck();
                if (d.fileId != null) {
                    if (typeof d.fileId === "object" ? d.fileId.low || d.fileId.high : $Number(d.fileId) !== 0) {
                        if ($util.Long)
                            m.fileId = $util.Long.fromValue(d.fileId, true);
                        else if (typeof d.fileId === "string")
                            m.fileId = $parseInt(d.fileId, 10);
                        else if (typeof d.fileId === "number")
                            m.fileId = d.fileId;
                        else if (typeof d.fileId === "object")
                            m.fileId = new $util.LongBits(d.fileId.low >>> 0, d.fileId.high >>> 0).toNumber(true);
                    }
                }
                if (d.received != null) {
                    if (typeof d.received === "object" ? d.received.low || d.received.high : $Number(d.received) !== 0) {
                        if ($util.Long)
                            m.received = $util.Long.fromValue(d.received, true);
                        else if (typeof d.received === "string")
                            m.received = $parseInt(d.received, 10);
                        else if (typeof d.received === "number")
                            m.received = d.received;
                        else if (typeof d.received === "object")
                            m.received = new $util.LongBits(d.received.low >>> 0, d.received.high >>> 0).toNumber(true);
                    }
                }
                return m;
            };

            FileAck.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.fileId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.fileId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.received = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.received = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                }
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.fileId = typeof m.fileId === "number" ? $BigInt(m.fileId) : $util.Long.fromBits(m.fileId.low >>> 0, m.fileId.high >>> 0, true).toBigInt();
                    else if (typeof m.fileId === "number")
                        d.fileId = o.longs === $String ? $String(m.fileId) : m.fileId;
                    else
                        d.fileId = o.longs === $String ? $util.Long.prototype.toString.call(m.fileId) : o.longs === $Number ? new $util.LongBits(m.fileId.low >>> 0, m.fileId.high >>> 0).toNumber(true) : m.fileId;
                }
                if (m.received != null && $Object.hasOwnProperty.call(m, "received")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.received = typeof m.received === "number" ? $BigInt(m.received) : $util.Long.fromBits(m.received.low >>> 0, m.received.high >>> 0, true).toBigInt();
                    else if (typeof m.received === "number")
                        d.received = o.longs === $String ? $String(m.received) : m.received;
                    else
                        d.received = o.longs === $String ? $util.Long.prototype.toString.call(m.received) : o.longs === $Number ? new $util.LongBits(m.received.low >>> 0, m.received.high >>> 0).toNumber(true) : m.received;
                }
                return d;
            };

            FileAck.prototype.toJSON = function() {
                return FileAck.toObject(this, $protobuf.util.toJSONOptions);
            };

            FileAck.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.FileAck";
            };

            return FileAck;
        })();

        v1.FileEnd = (function() {

            const FileEnd = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            FileEnd.prototype.fileId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            FileEnd.prototype.sha256 = $util.newBuffer([]);

            FileEnd.create = function(properties) {
                return new FileEnd(properties);
            };

            FileEnd.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId") && (typeof m.fileId === "object" ? m.fileId.low || m.fileId.high : m.fileId !== 0))
                    w.uint32(8).uint64(m.fileId);
                if (m.sha256 != null && $Object.hasOwnProperty.call(m, "sha256") && m.sha256.length)
                    w.uint32(18).bytes(m.sha256);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            FileEnd.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.FileEnd();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.fileId = v;
                            else
                                delete m.fileId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.sha256 = v;
                            else
                                delete m.sha256;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            FileEnd.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.FileEnd)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.FileEnd: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.FileEnd();
                if (d.fileId != null) {
                    if (typeof d.fileId === "object" ? d.fileId.low || d.fileId.high : $Number(d.fileId) !== 0) {
                        if ($util.Long)
                            m.fileId = $util.Long.fromValue(d.fileId, true);
                        else if (typeof d.fileId === "string")
                            m.fileId = $parseInt(d.fileId, 10);
                        else if (typeof d.fileId === "number")
                            m.fileId = d.fileId;
                        else if (typeof d.fileId === "object")
                            m.fileId = new $util.LongBits(d.fileId.low >>> 0, d.fileId.high >>> 0).toNumber(true);
                    }
                }
                if (d.sha256 != null) {
                    if (d.sha256.length) {
                        if (typeof d.sha256 === "string")
                            $util.base64.decode(d.sha256, m.sha256 = $util.newBuffer($util.base64.length(d.sha256)), 0);
                        else if (d.sha256.length >= 0)
                            m.sha256 = d.sha256;
                    }
                }
                return m;
            };

            FileEnd.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.fileId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.fileId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    if (o.bytes === $String)
                        d.sha256 = "";
                    else {
                        d.sha256 = [];
                        if (o.bytes !== $Array)
                            d.sha256 = $util.newBuffer(d.sha256);
                    }
                }
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.fileId = typeof m.fileId === "number" ? $BigInt(m.fileId) : $util.Long.fromBits(m.fileId.low >>> 0, m.fileId.high >>> 0, true).toBigInt();
                    else if (typeof m.fileId === "number")
                        d.fileId = o.longs === $String ? $String(m.fileId) : m.fileId;
                    else
                        d.fileId = o.longs === $String ? $util.Long.prototype.toString.call(m.fileId) : o.longs === $Number ? new $util.LongBits(m.fileId.low >>> 0, m.fileId.high >>> 0).toNumber(true) : m.fileId;
                }
                if (m.sha256 != null && $Object.hasOwnProperty.call(m, "sha256")) {
                    d.sha256 = o.bytes === $String ? $util.base64.encode(m.sha256, 0, m.sha256.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.sha256) : m.sha256;
                }
                return d;
            };

            FileEnd.prototype.toJSON = function() {
                return FileEnd.toObject(this, $protobuf.util.toJSONOptions);
            };

            FileEnd.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.FileEnd";
            };

            return FileEnd;
        })();

        v1.FileDone = (function() {

            const FileDone = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            FileDone.prototype.fileId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            FileDone.prototype.remotePath = "";

            FileDone.create = function(properties) {
                return new FileDone(properties);
            };

            FileDone.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId") && (typeof m.fileId === "object" ? m.fileId.low || m.fileId.high : m.fileId !== 0))
                    w.uint32(8).uint64(m.fileId);
                if (m.remotePath != null && $Object.hasOwnProperty.call(m, "remotePath") && m.remotePath !== "")
                    w.uint32(18).string(m.remotePath);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            FileDone.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.FileDone();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.fileId = v;
                            else
                                delete m.fileId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.remotePath = v;
                            else
                                delete m.remotePath;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            FileDone.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.FileDone)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.FileDone: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.FileDone();
                if (d.fileId != null) {
                    if (typeof d.fileId === "object" ? d.fileId.low || d.fileId.high : $Number(d.fileId) !== 0) {
                        if ($util.Long)
                            m.fileId = $util.Long.fromValue(d.fileId, true);
                        else if (typeof d.fileId === "string")
                            m.fileId = $parseInt(d.fileId, 10);
                        else if (typeof d.fileId === "number")
                            m.fileId = d.fileId;
                        else if (typeof d.fileId === "object")
                            m.fileId = new $util.LongBits(d.fileId.low >>> 0, d.fileId.high >>> 0).toNumber(true);
                    }
                }
                if (d.remotePath != null) {
                    if (typeof d.remotePath !== "string" || d.remotePath.length) {
                        m.remotePath = $String(d.remotePath);
                    }
                }
                return m;
            };

            FileDone.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.fileId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.fileId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.remotePath = "";
                }
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.fileId = typeof m.fileId === "number" ? $BigInt(m.fileId) : $util.Long.fromBits(m.fileId.low >>> 0, m.fileId.high >>> 0, true).toBigInt();
                    else if (typeof m.fileId === "number")
                        d.fileId = o.longs === $String ? $String(m.fileId) : m.fileId;
                    else
                        d.fileId = o.longs === $String ? $util.Long.prototype.toString.call(m.fileId) : o.longs === $Number ? new $util.LongBits(m.fileId.low >>> 0, m.fileId.high >>> 0).toNumber(true) : m.fileId;
                }
                if (m.remotePath != null && $Object.hasOwnProperty.call(m, "remotePath")) {
                    d.remotePath = m.remotePath;
                }
                return d;
            };

            FileDone.prototype.toJSON = function() {
                return FileDone.toObject(this, $protobuf.util.toJSONOptions);
            };

            FileDone.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.FileDone";
            };

            return FileDone;
        })();

        v1.FileCancel = (function() {

            const FileCancel = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            FileCancel.prototype.fileId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            FileCancel.prototype.reason = "";

            FileCancel.create = function(properties) {
                return new FileCancel(properties);
            };

            FileCancel.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId") && (typeof m.fileId === "object" ? m.fileId.low || m.fileId.high : m.fileId !== 0))
                    w.uint32(8).uint64(m.fileId);
                if (m.reason != null && $Object.hasOwnProperty.call(m, "reason") && m.reason !== "")
                    w.uint32(18).string(m.reason);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            FileCancel.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.FileCancel();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.fileId = v;
                            else
                                delete m.fileId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.reason = v;
                            else
                                delete m.reason;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            FileCancel.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.FileCancel)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.FileCancel: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.FileCancel();
                if (d.fileId != null) {
                    if (typeof d.fileId === "object" ? d.fileId.low || d.fileId.high : $Number(d.fileId) !== 0) {
                        if ($util.Long)
                            m.fileId = $util.Long.fromValue(d.fileId, true);
                        else if (typeof d.fileId === "string")
                            m.fileId = $parseInt(d.fileId, 10);
                        else if (typeof d.fileId === "number")
                            m.fileId = d.fileId;
                        else if (typeof d.fileId === "object")
                            m.fileId = new $util.LongBits(d.fileId.low >>> 0, d.fileId.high >>> 0).toNumber(true);
                    }
                }
                if (d.reason != null) {
                    if (typeof d.reason !== "string" || d.reason.length) {
                        m.reason = $String(d.reason);
                    }
                }
                return m;
            };

            FileCancel.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.fileId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.fileId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.reason = "";
                }
                if (m.fileId != null && $Object.hasOwnProperty.call(m, "fileId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.fileId = typeof m.fileId === "number" ? $BigInt(m.fileId) : $util.Long.fromBits(m.fileId.low >>> 0, m.fileId.high >>> 0, true).toBigInt();
                    else if (typeof m.fileId === "number")
                        d.fileId = o.longs === $String ? $String(m.fileId) : m.fileId;
                    else
                        d.fileId = o.longs === $String ? $util.Long.prototype.toString.call(m.fileId) : o.longs === $Number ? new $util.LongBits(m.fileId.low >>> 0, m.fileId.high >>> 0).toNumber(true) : m.fileId;
                }
                if (m.reason != null && $Object.hasOwnProperty.call(m, "reason")) {
                    d.reason = m.reason;
                }
                return d;
            };

            FileCancel.prototype.toJSON = function() {
                return FileCancel.toObject(this, $protobuf.util.toJSONOptions);
            };

            FileCancel.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.FileCancel";
            };

            return FileCancel;
        })();

        v1.ActionCatalog = (function() {

            const ActionCatalog = function (p) {
                this.actions = [];
                this.options = {};
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            ActionCatalog.prototype.catalogVer = "";
            ActionCatalog.prototype.app = "";
            ActionCatalog.prototype.actions = $util.emptyArray;
            ActionCatalog.prototype.options = $util.emptyObject;

            ActionCatalog.create = function(properties) {
                return new ActionCatalog(properties);
            };

            ActionCatalog.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.catalogVer != null && $Object.hasOwnProperty.call(m, "catalogVer") && m.catalogVer !== "")
                    w.uint32(10).string(m.catalogVer);
                if (m.app != null && $Object.hasOwnProperty.call(m, "app") && m.app !== "")
                    w.uint32(18).string(m.app);
                if (m.actions != null && m.actions.length) {
                    for (var i = 0; i < m.actions.length; ++i)
                        $root.rterm.v1.ActionDef.encode(m.actions[i], w.uint32(26).fork(), q + 1).ldelim();
                }
                if (m.options != null && $Object.hasOwnProperty.call(m, "options")) {
                    for (var ks = $Object.keys(m.options), i = 0; i < ks.length; ++i) {
                        w.uint32(34).fork().uint32(10).string(ks[i]);
                        $root.rterm.v1.OptionList.encode(m.options[ks[i]], w.uint32(18).fork(), q + 1).ldelim().ldelim();
                    }
                }
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            ActionCatalog.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, k, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.ActionCatalog();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.catalogVer = v;
                            else
                                delete m.catalogVer;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.app = v;
                            else
                                delete m.app;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if (!(m.actions && m.actions.length))
                                m.actions = [];
                            m.actions.push($root.rterm.v1.ActionDef.decode(r, r.size(), $undefined, q + 1));
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if (m.options === $util.emptyObject)
                                m.options = {};
                            var c2 = r.size() + r.pos;
                            if (c2 > r.len)
                                throw $RangeError("index out of range");
                            r.len = c2;
                            k = "";
                            v = null;
                            while (r.pos < c2) {
                                var t2 = r.tag();
                                u = t2 & 7;
                                switch (t2 >>>= 3) {
                                case 1:
                                    if (u !== 2)
                                        break;
                                    k = r.stringVerify();
                                    continue;
                                case 2:
                                    if (u !== 2)
                                        break;
                                    v = $root.rterm.v1.OptionList.decode(r, r.size(), $undefined, q + 1, v);
                                    continue;
                                }
                                r.skipType(u, q, t2);
                            }
                            if (r.pos !== c2)
                                throw $RangeError("index out of range");
                            r.len = c;
                            if (k === "__proto__")
                                $util.makeProp(m.options, k);
                            m.options[k] = v || new $root.rterm.v1.OptionList();
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            ActionCatalog.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.ActionCatalog)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.ActionCatalog: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.ActionCatalog();
                if (d.catalogVer != null) {
                    if (typeof d.catalogVer !== "string" || d.catalogVer.length) {
                        m.catalogVer = $String(d.catalogVer);
                    }
                }
                if (d.app != null) {
                    if (typeof d.app !== "string" || d.app.length) {
                        m.app = $String(d.app);
                    }
                }
                if (d.actions) {
                    if (!$Array.isArray(d.actions))
                        throw $TypeError(".rterm.v1.ActionCatalog.actions: array expected");
                    m.actions = $Array(d.actions.length);
                    for (var i = 0; i < d.actions.length; ++i) {
                        if (!$util.isObject(d.actions[i]))
                            throw $TypeError(".rterm.v1.ActionCatalog.actions: object expected");
                        m.actions[i] = $root.rterm.v1.ActionDef.fromObject(d.actions[i], q + 1);
                    }
                }
                if (d.options) {
                    if (!$util.isObject(d.options))
                        throw $TypeError(".rterm.v1.ActionCatalog.options: object expected");
                    m.options = {};
                    for (var ks = $Object.keys(d.options), i = 0; i < ks.length; ++i) {
                        if (ks[i] === "__proto__")
                            $util.makeProp(m.options, ks[i]);
                        if (!$util.isObject(d.options[ks[i]]))
                            throw $TypeError(".rterm.v1.ActionCatalog.options: object expected");
                        m.options[ks[i]] = $root.rterm.v1.OptionList.fromObject(d.options[ks[i]], q + 1);
                    }
                }
                return m;
            };

            ActionCatalog.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.actions = [];
                }
                if (o.objects || o.defaults) {
                    d.options = {};
                }
                if (o.defaults) {
                    d.catalogVer = "";
                    d.app = "";
                }
                if (m.catalogVer != null && $Object.hasOwnProperty.call(m, "catalogVer")) {
                    d.catalogVer = m.catalogVer;
                }
                if (m.app != null && $Object.hasOwnProperty.call(m, "app")) {
                    d.app = m.app;
                }
                if (m.actions && m.actions.length) {
                    d.actions = $Array(m.actions.length);
                    for (var j = 0; j < m.actions.length; ++j) {
                        d.actions[j] = $root.rterm.v1.ActionDef.toObject(m.actions[j], o, q + 1);
                    }
                }
                var ks2;
                if (m.options && (ks2 = $Object.keys(m.options)).length) {
                    d.options = {};
                    for (var j = 0; j < ks2.length; ++j) {
                        if (ks2[j] === "__proto__")
                            $util.makeProp(d.options, ks2[j]);
                        d.options[ks2[j]] = $root.rterm.v1.OptionList.toObject(m.options[ks2[j]], o, q + 1);
                    }
                }
                return d;
            };

            ActionCatalog.prototype.toJSON = function() {
                return ActionCatalog.toObject(this, $protobuf.util.toJSONOptions);
            };

            ActionCatalog.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.ActionCatalog";
            };

            return ActionCatalog;
        })();

        v1.OptionList = (function() {

            const OptionList = function (p) {
                this.items = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            OptionList.prototype.items = $util.emptyArray;

            OptionList.create = function(properties) {
                return new OptionList(properties);
            };

            OptionList.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.items != null && m.items.length) {
                    for (var i = 0; i < m.items.length; ++i)
                        $root.rterm.v1.ParamOption.encode(m.items[i], w.uint32(10).fork(), q + 1).ldelim();
                }
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            OptionList.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.OptionList();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if (!(m.items && m.items.length))
                                m.items = [];
                            m.items.push($root.rterm.v1.ParamOption.decode(r, r.size(), $undefined, q + 1));
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            OptionList.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.OptionList)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.OptionList: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.OptionList();
                if (d.items) {
                    if (!$Array.isArray(d.items))
                        throw $TypeError(".rterm.v1.OptionList.items: array expected");
                    m.items = $Array(d.items.length);
                    for (var i = 0; i < d.items.length; ++i) {
                        if (!$util.isObject(d.items[i]))
                            throw $TypeError(".rterm.v1.OptionList.items: object expected");
                        m.items[i] = $root.rterm.v1.ParamOption.fromObject(d.items[i], q + 1);
                    }
                }
                return m;
            };

            OptionList.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.items = [];
                }
                if (m.items && m.items.length) {
                    d.items = $Array(m.items.length);
                    for (var j = 0; j < m.items.length; ++j) {
                        d.items[j] = $root.rterm.v1.ParamOption.toObject(m.items[j], o, q + 1);
                    }
                }
                return d;
            };

            OptionList.prototype.toJSON = function() {
                return OptionList.toObject(this, $protobuf.util.toJSONOptions);
            };

            OptionList.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.OptionList";
            };

            return OptionList;
        })();

        v1.ParamOption = (function() {

            const ParamOption = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            ParamOption.prototype.value = "";
            ParamOption.prototype.label = "";

            ParamOption.create = function(properties) {
                return new ParamOption(properties);
            };

            ParamOption.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.value != null && $Object.hasOwnProperty.call(m, "value") && m.value !== "")
                    w.uint32(10).string(m.value);
                if (m.label != null && $Object.hasOwnProperty.call(m, "label") && m.label !== "")
                    w.uint32(18).string(m.label);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            ParamOption.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.ParamOption();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.value = v;
                            else
                                delete m.value;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.label = v;
                            else
                                delete m.label;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            ParamOption.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.ParamOption)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.ParamOption: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.ParamOption();
                if (d.value != null) {
                    if (typeof d.value !== "string" || d.value.length) {
                        m.value = $String(d.value);
                    }
                }
                if (d.label != null) {
                    if (typeof d.label !== "string" || d.label.length) {
                        m.label = $String(d.label);
                    }
                }
                return m;
            };

            ParamOption.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.value = "";
                    d.label = "";
                }
                if (m.value != null && $Object.hasOwnProperty.call(m, "value")) {
                    d.value = m.value;
                }
                if (m.label != null && $Object.hasOwnProperty.call(m, "label")) {
                    d.label = m.label;
                }
                return d;
            };

            ParamOption.prototype.toJSON = function() {
                return ParamOption.toObject(this, $protobuf.util.toJSONOptions);
            };

            ParamOption.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.ParamOption";
            };

            return ParamOption;
        })();

        v1.ActionDef = (function() {

            const ActionDef = function (p) {
                this.params = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            ActionDef.prototype.id = "";
            ActionDef.prototype.title = "";
            ActionDef.prototype.group = "";
            ActionDef.prototype.placement = "";
            ActionDef.prototype.kind = "";
            ActionDef.prototype.params = $util.emptyArray;
            ActionDef.prototype.confirm = "";
            ActionDef.prototype.note = "";
            ActionDef.prototype.enabledWhen = "";

            ActionDef.create = function(properties) {
                return new ActionDef(properties);
            };

            ActionDef.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.id != null && $Object.hasOwnProperty.call(m, "id") && m.id !== "")
                    w.uint32(10).string(m.id);
                if (m.title != null && $Object.hasOwnProperty.call(m, "title") && m.title !== "")
                    w.uint32(18).string(m.title);
                if (m.group != null && $Object.hasOwnProperty.call(m, "group") && m.group !== "")
                    w.uint32(26).string(m.group);
                if (m.placement != null && $Object.hasOwnProperty.call(m, "placement") && m.placement !== "")
                    w.uint32(34).string(m.placement);
                if (m.kind != null && $Object.hasOwnProperty.call(m, "kind") && m.kind !== "")
                    w.uint32(42).string(m.kind);
                if (m.params != null && m.params.length) {
                    for (var i = 0; i < m.params.length; ++i)
                        $root.rterm.v1.ActionParam.encode(m.params[i], w.uint32(50).fork(), q + 1).ldelim();
                }
                if (m.confirm != null && $Object.hasOwnProperty.call(m, "confirm") && m.confirm !== "")
                    w.uint32(58).string(m.confirm);
                if (m.note != null && $Object.hasOwnProperty.call(m, "note") && m.note !== "")
                    w.uint32(66).string(m.note);
                if (m.enabledWhen != null && $Object.hasOwnProperty.call(m, "enabledWhen") && m.enabledWhen !== "")
                    w.uint32(74).string(m.enabledWhen);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            ActionDef.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.ActionDef();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.id = v;
                            else
                                delete m.id;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.title = v;
                            else
                                delete m.title;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.group = v;
                            else
                                delete m.group;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.placement = v;
                            else
                                delete m.placement;
                            continue;
                        }
                    case 5: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.kind = v;
                            else
                                delete m.kind;
                            continue;
                        }
                    case 6: {
                            if (u !== 2)
                                break;
                            if (!(m.params && m.params.length))
                                m.params = [];
                            m.params.push($root.rterm.v1.ActionParam.decode(r, r.size(), $undefined, q + 1));
                            continue;
                        }
                    case 7: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.confirm = v;
                            else
                                delete m.confirm;
                            continue;
                        }
                    case 8: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.note = v;
                            else
                                delete m.note;
                            continue;
                        }
                    case 9: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.enabledWhen = v;
                            else
                                delete m.enabledWhen;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            ActionDef.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.ActionDef)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.ActionDef: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.ActionDef();
                if (d.id != null) {
                    if (typeof d.id !== "string" || d.id.length) {
                        m.id = $String(d.id);
                    }
                }
                if (d.title != null) {
                    if (typeof d.title !== "string" || d.title.length) {
                        m.title = $String(d.title);
                    }
                }
                if (d.group != null) {
                    if (typeof d.group !== "string" || d.group.length) {
                        m.group = $String(d.group);
                    }
                }
                if (d.placement != null) {
                    if (typeof d.placement !== "string" || d.placement.length) {
                        m.placement = $String(d.placement);
                    }
                }
                if (d.kind != null) {
                    if (typeof d.kind !== "string" || d.kind.length) {
                        m.kind = $String(d.kind);
                    }
                }
                if (d.params) {
                    if (!$Array.isArray(d.params))
                        throw $TypeError(".rterm.v1.ActionDef.params: array expected");
                    m.params = $Array(d.params.length);
                    for (var i = 0; i < d.params.length; ++i) {
                        if (!$util.isObject(d.params[i]))
                            throw $TypeError(".rterm.v1.ActionDef.params: object expected");
                        m.params[i] = $root.rterm.v1.ActionParam.fromObject(d.params[i], q + 1);
                    }
                }
                if (d.confirm != null) {
                    if (typeof d.confirm !== "string" || d.confirm.length) {
                        m.confirm = $String(d.confirm);
                    }
                }
                if (d.note != null) {
                    if (typeof d.note !== "string" || d.note.length) {
                        m.note = $String(d.note);
                    }
                }
                if (d.enabledWhen != null) {
                    if (typeof d.enabledWhen !== "string" || d.enabledWhen.length) {
                        m.enabledWhen = $String(d.enabledWhen);
                    }
                }
                return m;
            };

            ActionDef.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.params = [];
                }
                if (o.defaults) {
                    d.id = "";
                    d.title = "";
                    d.group = "";
                    d.placement = "";
                    d.kind = "";
                    d.confirm = "";
                    d.note = "";
                    d.enabledWhen = "";
                }
                if (m.id != null && $Object.hasOwnProperty.call(m, "id")) {
                    d.id = m.id;
                }
                if (m.title != null && $Object.hasOwnProperty.call(m, "title")) {
                    d.title = m.title;
                }
                if (m.group != null && $Object.hasOwnProperty.call(m, "group")) {
                    d.group = m.group;
                }
                if (m.placement != null && $Object.hasOwnProperty.call(m, "placement")) {
                    d.placement = m.placement;
                }
                if (m.kind != null && $Object.hasOwnProperty.call(m, "kind")) {
                    d.kind = m.kind;
                }
                if (m.params && m.params.length) {
                    d.params = $Array(m.params.length);
                    for (var j = 0; j < m.params.length; ++j) {
                        d.params[j] = $root.rterm.v1.ActionParam.toObject(m.params[j], o, q + 1);
                    }
                }
                if (m.confirm != null && $Object.hasOwnProperty.call(m, "confirm")) {
                    d.confirm = m.confirm;
                }
                if (m.note != null && $Object.hasOwnProperty.call(m, "note")) {
                    d.note = m.note;
                }
                if (m.enabledWhen != null && $Object.hasOwnProperty.call(m, "enabledWhen")) {
                    d.enabledWhen = m.enabledWhen;
                }
                return d;
            };

            ActionDef.prototype.toJSON = function() {
                return ActionDef.toObject(this, $protobuf.util.toJSONOptions);
            };

            ActionDef.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.ActionDef";
            };

            return ActionDef;
        })();

        v1.ActionParam = (function() {

            const ActionParam = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            ActionParam.prototype.name = "";
            ActionParam.prototype.label = "";
            ActionParam.prototype.type = "";
            ActionParam.prototype.optionsRef = "";
            ActionParam.prototype.allowCustom = false;
            ActionParam.prototype.required = false;
            ActionParam.prototype.defaultValue = "";

            ActionParam.create = function(properties) {
                return new ActionParam(properties);
            };

            ActionParam.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.name != null && $Object.hasOwnProperty.call(m, "name") && m.name !== "")
                    w.uint32(10).string(m.name);
                if (m.label != null && $Object.hasOwnProperty.call(m, "label") && m.label !== "")
                    w.uint32(18).string(m.label);
                if (m.type != null && $Object.hasOwnProperty.call(m, "type") && m.type !== "")
                    w.uint32(26).string(m.type);
                if (m.optionsRef != null && $Object.hasOwnProperty.call(m, "optionsRef") && m.optionsRef !== "")
                    w.uint32(34).string(m.optionsRef);
                if (m.allowCustom != null && $Object.hasOwnProperty.call(m, "allowCustom") && m.allowCustom !== false)
                    w.uint32(40).bool(m.allowCustom);
                if (m.required != null && $Object.hasOwnProperty.call(m, "required") && m.required !== false)
                    w.uint32(48).bool(m.required);
                if (m.defaultValue != null && $Object.hasOwnProperty.call(m, "defaultValue") && m.defaultValue !== "")
                    w.uint32(58).string(m.defaultValue);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            ActionParam.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.ActionParam();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.name = v;
                            else
                                delete m.name;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.label = v;
                            else
                                delete m.label;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.type = v;
                            else
                                delete m.type;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.optionsRef = v;
                            else
                                delete m.optionsRef;
                            continue;
                        }
                    case 5: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.allowCustom = v;
                            else
                                delete m.allowCustom;
                            continue;
                        }
                    case 6: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.required = v;
                            else
                                delete m.required;
                            continue;
                        }
                    case 7: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.defaultValue = v;
                            else
                                delete m.defaultValue;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            ActionParam.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.ActionParam)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.ActionParam: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.ActionParam();
                if (d.name != null) {
                    if (typeof d.name !== "string" || d.name.length) {
                        m.name = $String(d.name);
                    }
                }
                if (d.label != null) {
                    if (typeof d.label !== "string" || d.label.length) {
                        m.label = $String(d.label);
                    }
                }
                if (d.type != null) {
                    if (typeof d.type !== "string" || d.type.length) {
                        m.type = $String(d.type);
                    }
                }
                if (d.optionsRef != null) {
                    if (typeof d.optionsRef !== "string" || d.optionsRef.length) {
                        m.optionsRef = $String(d.optionsRef);
                    }
                }
                if (d.allowCustom != null) {
                    if (d.allowCustom) {
                        m.allowCustom = $Boolean(d.allowCustom);
                    }
                }
                if (d.required != null) {
                    if (d.required) {
                        m.required = $Boolean(d.required);
                    }
                }
                if (d.defaultValue != null) {
                    if (typeof d.defaultValue !== "string" || d.defaultValue.length) {
                        m.defaultValue = $String(d.defaultValue);
                    }
                }
                return m;
            };

            ActionParam.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.name = "";
                    d.label = "";
                    d.type = "";
                    d.optionsRef = "";
                    d.allowCustom = false;
                    d.required = false;
                    d.defaultValue = "";
                }
                if (m.name != null && $Object.hasOwnProperty.call(m, "name")) {
                    d.name = m.name;
                }
                if (m.label != null && $Object.hasOwnProperty.call(m, "label")) {
                    d.label = m.label;
                }
                if (m.type != null && $Object.hasOwnProperty.call(m, "type")) {
                    d.type = m.type;
                }
                if (m.optionsRef != null && $Object.hasOwnProperty.call(m, "optionsRef")) {
                    d.optionsRef = m.optionsRef;
                }
                if (m.allowCustom != null && $Object.hasOwnProperty.call(m, "allowCustom")) {
                    d.allowCustom = m.allowCustom;
                }
                if (m.required != null && $Object.hasOwnProperty.call(m, "required")) {
                    d.required = m.required;
                }
                if (m.defaultValue != null && $Object.hasOwnProperty.call(m, "defaultValue")) {
                    d.defaultValue = m.defaultValue;
                }
                return d;
            };

            ActionParam.prototype.toJSON = function() {
                return ActionParam.toObject(this, $protobuf.util.toJSONOptions);
            };

            ActionParam.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.ActionParam";
            };

            return ActionParam;
        })();

        v1.TermAction = (function() {

            const TermAction = function (p) {
                this.args = {};
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermAction.prototype.reqId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermAction.prototype.actionId = "";
            TermAction.prototype.args = $util.emptyObject;

            TermAction.create = function(properties) {
                return new TermAction(properties);
            };

            TermAction.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId") && (typeof m.reqId === "object" ? m.reqId.low || m.reqId.high : m.reqId !== 0))
                    w.uint32(8).uint64(m.reqId);
                if (m.actionId != null && $Object.hasOwnProperty.call(m, "actionId") && m.actionId !== "")
                    w.uint32(18).string(m.actionId);
                if (m.args != null && $Object.hasOwnProperty.call(m, "args")) {
                    for (var ks = $Object.keys(m.args), i = 0; i < ks.length; ++i) {
                        w.uint32(26).fork().uint32(10).string(ks[i]).uint32(18).string(m.args[ks[i]]).ldelim();
                    }
                }
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermAction.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, k, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermAction();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.reqId = v;
                            else
                                delete m.reqId;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.actionId = v;
                            else
                                delete m.actionId;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if (m.args === $util.emptyObject)
                                m.args = {};
                            var c2 = r.size() + r.pos;
                            if (c2 > r.len)
                                throw $RangeError("index out of range");
                            r.len = c2;
                            k = "";
                            v = "";
                            while (r.pos < c2) {
                                var t2 = r.tag();
                                u = t2 & 7;
                                switch (t2 >>>= 3) {
                                case 1:
                                    if (u !== 2)
                                        break;
                                    k = r.stringVerify();
                                    continue;
                                case 2:
                                    if (u !== 2)
                                        break;
                                    v = r.stringVerify();
                                    continue;
                                }
                                r.skipType(u, q, t2);
                            }
                            if (r.pos !== c2)
                                throw $RangeError("index out of range");
                            r.len = c;
                            if (k === "__proto__")
                                $util.makeProp(m.args, k);
                            m.args[k] = v;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermAction.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermAction)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermAction: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermAction();
                if (d.reqId != null) {
                    if (typeof d.reqId === "object" ? d.reqId.low || d.reqId.high : $Number(d.reqId) !== 0) {
                        if ($util.Long)
                            m.reqId = $util.Long.fromValue(d.reqId, true);
                        else if (typeof d.reqId === "string")
                            m.reqId = $parseInt(d.reqId, 10);
                        else if (typeof d.reqId === "number")
                            m.reqId = d.reqId;
                        else if (typeof d.reqId === "object")
                            m.reqId = new $util.LongBits(d.reqId.low >>> 0, d.reqId.high >>> 0).toNumber(true);
                    }
                }
                if (d.actionId != null) {
                    if (typeof d.actionId !== "string" || d.actionId.length) {
                        m.actionId = $String(d.actionId);
                    }
                }
                if (d.args) {
                    if (!$util.isObject(d.args))
                        throw $TypeError(".rterm.v1.TermAction.args: object expected");
                    m.args = {};
                    for (var ks = $Object.keys(d.args), i = 0; i < ks.length; ++i) {
                        if (ks[i] === "__proto__")
                            $util.makeProp(m.args, ks[i]);
                        m.args[ks[i]] = $String(d.args[ks[i]]);
                    }
                }
                return m;
            };

            TermAction.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.objects || o.defaults) {
                    d.args = {};
                }
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.reqId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.reqId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.actionId = "";
                }
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.reqId = typeof m.reqId === "number" ? $BigInt(m.reqId) : $util.Long.fromBits(m.reqId.low >>> 0, m.reqId.high >>> 0, true).toBigInt();
                    else if (typeof m.reqId === "number")
                        d.reqId = o.longs === $String ? $String(m.reqId) : m.reqId;
                    else
                        d.reqId = o.longs === $String ? $util.Long.prototype.toString.call(m.reqId) : o.longs === $Number ? new $util.LongBits(m.reqId.low >>> 0, m.reqId.high >>> 0).toNumber(true) : m.reqId;
                }
                if (m.actionId != null && $Object.hasOwnProperty.call(m, "actionId")) {
                    d.actionId = m.actionId;
                }
                var ks2;
                if (m.args && (ks2 = $Object.keys(m.args)).length) {
                    d.args = {};
                    for (var j = 0; j < ks2.length; ++j) {
                        if (ks2[j] === "__proto__")
                            $util.makeProp(d.args, ks2[j]);
                        d.args[ks2[j]] = m.args[ks2[j]];
                    }
                }
                return d;
            };

            TermAction.prototype.toJSON = function() {
                return TermAction.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermAction.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermAction";
            };

            return TermAction;
        })();

        v1.TermActionResult = (function() {

            const TermActionResult = function (p) {
                this.returnKeys = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            TermActionResult.prototype.reqId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            TermActionResult.prototype.ok = false;
            TermActionResult.prototype.error = "";
            TermActionResult.prototype.passthrough = false;
            TermActionResult.prototype.returnKeys = $util.emptyArray;

            TermActionResult.create = function(properties) {
                return new TermActionResult(properties);
            };

            TermActionResult.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId") && (typeof m.reqId === "object" ? m.reqId.low || m.reqId.high : m.reqId !== 0))
                    w.uint32(8).uint64(m.reqId);
                if (m.ok != null && $Object.hasOwnProperty.call(m, "ok") && m.ok !== false)
                    w.uint32(16).bool(m.ok);
                if (m.error != null && $Object.hasOwnProperty.call(m, "error") && m.error !== "")
                    w.uint32(26).string(m.error);
                if (m.passthrough != null && $Object.hasOwnProperty.call(m, "passthrough") && m.passthrough !== false)
                    w.uint32(32).bool(m.passthrough);
                if (m.returnKeys != null && m.returnKeys.length) {
                    for (var i = 0; i < m.returnKeys.length; ++i)
                        w.uint32(42).string(m.returnKeys[i]);
                }
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            TermActionResult.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.TermActionResult();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.reqId = v;
                            else
                                delete m.reqId;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.ok = v;
                            else
                                delete m.ok;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.error = v;
                            else
                                delete m.error;
                            continue;
                        }
                    case 4: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.passthrough = v;
                            else
                                delete m.passthrough;
                            continue;
                        }
                    case 5: {
                            if (u !== 2)
                                break;
                            if (!(m.returnKeys && m.returnKeys.length))
                                m.returnKeys = [];
                            m.returnKeys.push(r.stringVerify());
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            TermActionResult.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.TermActionResult)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.TermActionResult: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.TermActionResult();
                if (d.reqId != null) {
                    if (typeof d.reqId === "object" ? d.reqId.low || d.reqId.high : $Number(d.reqId) !== 0) {
                        if ($util.Long)
                            m.reqId = $util.Long.fromValue(d.reqId, true);
                        else if (typeof d.reqId === "string")
                            m.reqId = $parseInt(d.reqId, 10);
                        else if (typeof d.reqId === "number")
                            m.reqId = d.reqId;
                        else if (typeof d.reqId === "object")
                            m.reqId = new $util.LongBits(d.reqId.low >>> 0, d.reqId.high >>> 0).toNumber(true);
                    }
                }
                if (d.ok != null) {
                    if (d.ok) {
                        m.ok = $Boolean(d.ok);
                    }
                }
                if (d.error != null) {
                    if (typeof d.error !== "string" || d.error.length) {
                        m.error = $String(d.error);
                    }
                }
                if (d.passthrough != null) {
                    if (d.passthrough) {
                        m.passthrough = $Boolean(d.passthrough);
                    }
                }
                if (d.returnKeys) {
                    if (!$Array.isArray(d.returnKeys))
                        throw $TypeError(".rterm.v1.TermActionResult.returnKeys: array expected");
                    m.returnKeys = $Array(d.returnKeys.length);
                    for (var i = 0; i < d.returnKeys.length; ++i) {
                        m.returnKeys[i] = $String(d.returnKeys[i]);
                    }
                }
                return m;
            };

            TermActionResult.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.returnKeys = [];
                }
                if (o.defaults) {
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.reqId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.reqId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.ok = false;
                    d.error = "";
                    d.passthrough = false;
                }
                if (m.reqId != null && $Object.hasOwnProperty.call(m, "reqId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.reqId = typeof m.reqId === "number" ? $BigInt(m.reqId) : $util.Long.fromBits(m.reqId.low >>> 0, m.reqId.high >>> 0, true).toBigInt();
                    else if (typeof m.reqId === "number")
                        d.reqId = o.longs === $String ? $String(m.reqId) : m.reqId;
                    else
                        d.reqId = o.longs === $String ? $util.Long.prototype.toString.call(m.reqId) : o.longs === $Number ? new $util.LongBits(m.reqId.low >>> 0, m.reqId.high >>> 0).toNumber(true) : m.reqId;
                }
                if (m.ok != null && $Object.hasOwnProperty.call(m, "ok")) {
                    d.ok = m.ok;
                }
                if (m.error != null && $Object.hasOwnProperty.call(m, "error")) {
                    d.error = m.error;
                }
                if (m.passthrough != null && $Object.hasOwnProperty.call(m, "passthrough")) {
                    d.passthrough = m.passthrough;
                }
                if (m.returnKeys && m.returnKeys.length) {
                    d.returnKeys = $Array(m.returnKeys.length);
                    for (var j = 0; j < m.returnKeys.length; ++j) {
                        d.returnKeys[j] = m.returnKeys[j];
                    }
                }
                return d;
            };

            TermActionResult.prototype.toJSON = function() {
                return TermActionResult.toObject(this, $protobuf.util.toJSONOptions);
            };

            TermActionResult.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.TermActionResult";
            };

            return TermActionResult;
        })();

        v1.AppState = (function() {

            const AppState = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            AppState.prototype.app = "";
            AppState.prototype.running = false;
            AppState.prototype.stateful = false;
            AppState.prototype.version = "";
            AppState.prototype.activity = "";
            AppState.prototype.model = "";
            AppState.prototype.modelId = "";
            AppState.prototype.effort = "";
            AppState.prototype.fastMode = false;
            AppState.prototype.thinking = false;
            AppState.prototype.contextUsedPct = 0;
            AppState.prototype.hasContext = false;
            AppState.prototype.cwd = "";
            AppState.prototype.sessionId = "";
            AppState.prototype.sessionName = "";
            AppState.prototype.costUsd = 0;

            AppState.create = function(properties) {
                return new AppState(properties);
            };

            AppState.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.app != null && $Object.hasOwnProperty.call(m, "app") && m.app !== "")
                    w.uint32(10).string(m.app);
                if (m.running != null && $Object.hasOwnProperty.call(m, "running") && m.running !== false)
                    w.uint32(16).bool(m.running);
                if (m.stateful != null && $Object.hasOwnProperty.call(m, "stateful") && m.stateful !== false)
                    w.uint32(24).bool(m.stateful);
                if (m.version != null && $Object.hasOwnProperty.call(m, "version") && m.version !== "")
                    w.uint32(34).string(m.version);
                if (m.activity != null && $Object.hasOwnProperty.call(m, "activity") && m.activity !== "")
                    w.uint32(42).string(m.activity);
                if (m.model != null && $Object.hasOwnProperty.call(m, "model") && m.model !== "")
                    w.uint32(50).string(m.model);
                if (m.modelId != null && $Object.hasOwnProperty.call(m, "modelId") && m.modelId !== "")
                    w.uint32(58).string(m.modelId);
                if (m.effort != null && $Object.hasOwnProperty.call(m, "effort") && m.effort !== "")
                    w.uint32(66).string(m.effort);
                if (m.fastMode != null && $Object.hasOwnProperty.call(m, "fastMode") && m.fastMode !== false)
                    w.uint32(72).bool(m.fastMode);
                if (m.thinking != null && $Object.hasOwnProperty.call(m, "thinking") && m.thinking !== false)
                    w.uint32(80).bool(m.thinking);
                if (m.contextUsedPct != null && $Object.hasOwnProperty.call(m, "contextUsedPct") && m.contextUsedPct !== 0)
                    w.uint32(88).uint32(m.contextUsedPct);
                if (m.hasContext != null && $Object.hasOwnProperty.call(m, "hasContext") && m.hasContext !== false)
                    w.uint32(96).bool(m.hasContext);
                if (m.cwd != null && $Object.hasOwnProperty.call(m, "cwd") && m.cwd !== "")
                    w.uint32(106).string(m.cwd);
                if (m.sessionId != null && $Object.hasOwnProperty.call(m, "sessionId") && m.sessionId !== "")
                    w.uint32(114).string(m.sessionId);
                if (m.sessionName != null && $Object.hasOwnProperty.call(m, "sessionName") && m.sessionName !== "")
                    w.uint32(122).string(m.sessionName);
                if (m.costUsd != null && $Object.hasOwnProperty.call(m, "costUsd") && !$Object.is(m.costUsd, 0))
                    w.uint32(129).double(m.costUsd);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            AppState.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.AppState();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.app = v;
                            else
                                delete m.app;
                            continue;
                        }
                    case 2: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.running = v;
                            else
                                delete m.running;
                            continue;
                        }
                    case 3: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.stateful = v;
                            else
                                delete m.stateful;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.version = v;
                            else
                                delete m.version;
                            continue;
                        }
                    case 5: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.activity = v;
                            else
                                delete m.activity;
                            continue;
                        }
                    case 6: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.model = v;
                            else
                                delete m.model;
                            continue;
                        }
                    case 7: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.modelId = v;
                            else
                                delete m.modelId;
                            continue;
                        }
                    case 8: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.effort = v;
                            else
                                delete m.effort;
                            continue;
                        }
                    case 9: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.fastMode = v;
                            else
                                delete m.fastMode;
                            continue;
                        }
                    case 10: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.thinking = v;
                            else
                                delete m.thinking;
                            continue;
                        }
                    case 11: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.contextUsedPct = v;
                            else
                                delete m.contextUsedPct;
                            continue;
                        }
                    case 12: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.hasContext = v;
                            else
                                delete m.hasContext;
                            continue;
                        }
                    case 13: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.cwd = v;
                            else
                                delete m.cwd;
                            continue;
                        }
                    case 14: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.sessionId = v;
                            else
                                delete m.sessionId;
                            continue;
                        }
                    case 15: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.sessionName = v;
                            else
                                delete m.sessionName;
                            continue;
                        }
                    case 16: {
                            if (u !== 1)
                                break;
                            if (!$Object.is(v = r.double(), 0))
                                m.costUsd = v;
                            else
                                delete m.costUsd;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            AppState.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.AppState)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.AppState: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.AppState();
                if (d.app != null) {
                    if (typeof d.app !== "string" || d.app.length) {
                        m.app = $String(d.app);
                    }
                }
                if (d.running != null) {
                    if (d.running) {
                        m.running = $Boolean(d.running);
                    }
                }
                if (d.stateful != null) {
                    if (d.stateful) {
                        m.stateful = $Boolean(d.stateful);
                    }
                }
                if (d.version != null) {
                    if (typeof d.version !== "string" || d.version.length) {
                        m.version = $String(d.version);
                    }
                }
                if (d.activity != null) {
                    if (typeof d.activity !== "string" || d.activity.length) {
                        m.activity = $String(d.activity);
                    }
                }
                if (d.model != null) {
                    if (typeof d.model !== "string" || d.model.length) {
                        m.model = $String(d.model);
                    }
                }
                if (d.modelId != null) {
                    if (typeof d.modelId !== "string" || d.modelId.length) {
                        m.modelId = $String(d.modelId);
                    }
                }
                if (d.effort != null) {
                    if (typeof d.effort !== "string" || d.effort.length) {
                        m.effort = $String(d.effort);
                    }
                }
                if (d.fastMode != null) {
                    if (d.fastMode) {
                        m.fastMode = $Boolean(d.fastMode);
                    }
                }
                if (d.thinking != null) {
                    if (d.thinking) {
                        m.thinking = $Boolean(d.thinking);
                    }
                }
                if (d.contextUsedPct != null) {
                    if ($Number(d.contextUsedPct) !== 0) {
                        m.contextUsedPct = d.contextUsedPct >>> 0;
                    }
                }
                if (d.hasContext != null) {
                    if (d.hasContext) {
                        m.hasContext = $Boolean(d.hasContext);
                    }
                }
                if (d.cwd != null) {
                    if (typeof d.cwd !== "string" || d.cwd.length) {
                        m.cwd = $String(d.cwd);
                    }
                }
                if (d.sessionId != null) {
                    if (typeof d.sessionId !== "string" || d.sessionId.length) {
                        m.sessionId = $String(d.sessionId);
                    }
                }
                if (d.sessionName != null) {
                    if (typeof d.sessionName !== "string" || d.sessionName.length) {
                        m.sessionName = $String(d.sessionName);
                    }
                }
                if (d.costUsd != null) {
                    if (!$Object.is($Number(d.costUsd), 0)) {
                        m.costUsd = $Number(d.costUsd);
                    }
                }
                return m;
            };

            AppState.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.app = "";
                    d.running = false;
                    d.stateful = false;
                    d.version = "";
                    d.activity = "";
                    d.model = "";
                    d.modelId = "";
                    d.effort = "";
                    d.fastMode = false;
                    d.thinking = false;
                    d.contextUsedPct = 0;
                    d.hasContext = false;
                    d.cwd = "";
                    d.sessionId = "";
                    d.sessionName = "";
                    d.costUsd = 0;
                }
                if (m.app != null && $Object.hasOwnProperty.call(m, "app")) {
                    d.app = m.app;
                }
                if (m.running != null && $Object.hasOwnProperty.call(m, "running")) {
                    d.running = m.running;
                }
                if (m.stateful != null && $Object.hasOwnProperty.call(m, "stateful")) {
                    d.stateful = m.stateful;
                }
                if (m.version != null && $Object.hasOwnProperty.call(m, "version")) {
                    d.version = m.version;
                }
                if (m.activity != null && $Object.hasOwnProperty.call(m, "activity")) {
                    d.activity = m.activity;
                }
                if (m.model != null && $Object.hasOwnProperty.call(m, "model")) {
                    d.model = m.model;
                }
                if (m.modelId != null && $Object.hasOwnProperty.call(m, "modelId")) {
                    d.modelId = m.modelId;
                }
                if (m.effort != null && $Object.hasOwnProperty.call(m, "effort")) {
                    d.effort = m.effort;
                }
                if (m.fastMode != null && $Object.hasOwnProperty.call(m, "fastMode")) {
                    d.fastMode = m.fastMode;
                }
                if (m.thinking != null && $Object.hasOwnProperty.call(m, "thinking")) {
                    d.thinking = m.thinking;
                }
                if (m.contextUsedPct != null && $Object.hasOwnProperty.call(m, "contextUsedPct")) {
                    d.contextUsedPct = m.contextUsedPct;
                }
                if (m.hasContext != null && $Object.hasOwnProperty.call(m, "hasContext")) {
                    d.hasContext = m.hasContext;
                }
                if (m.cwd != null && $Object.hasOwnProperty.call(m, "cwd")) {
                    d.cwd = m.cwd;
                }
                if (m.sessionId != null && $Object.hasOwnProperty.call(m, "sessionId")) {
                    d.sessionId = m.sessionId;
                }
                if (m.sessionName != null && $Object.hasOwnProperty.call(m, "sessionName")) {
                    d.sessionName = m.sessionName;
                }
                if (m.costUsd != null && $Object.hasOwnProperty.call(m, "costUsd")) {
                    d.costUsd = o.json && !$isFinite(m.costUsd) ? $String(m.costUsd) : m.costUsd;
                }
                return d;
            };

            AppState.prototype.toJSON = function() {
                return AppState.toObject(this, $protobuf.util.toJSONOptions);
            };

            AppState.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.AppState";
            };

            return AppState;
        })();

        v1.AppNotice = (function() {

            const AppNotice = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            AppNotice.prototype.kind = "";
            AppNotice.prototype.title = "";
            AppNotice.prototype.text = "";
            AppNotice.prototype.noticeId = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
            AppNotice.prototype.toolName = "";
            AppNotice.prototype.toolSummary = "";
            AppNotice.prototype.resolved = false;
            AppNotice.prototype.truncated = false;

            AppNotice.create = function(properties) {
                return new AppNotice(properties);
            };

            AppNotice.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.kind != null && $Object.hasOwnProperty.call(m, "kind") && m.kind !== "")
                    w.uint32(10).string(m.kind);
                if (m.title != null && $Object.hasOwnProperty.call(m, "title") && m.title !== "")
                    w.uint32(18).string(m.title);
                if (m.text != null && $Object.hasOwnProperty.call(m, "text") && m.text !== "")
                    w.uint32(26).string(m.text);
                if (m.noticeId != null && $Object.hasOwnProperty.call(m, "noticeId") && (typeof m.noticeId === "object" ? m.noticeId.low || m.noticeId.high : m.noticeId !== 0))
                    w.uint32(32).uint64(m.noticeId);
                if (m.toolName != null && $Object.hasOwnProperty.call(m, "toolName") && m.toolName !== "")
                    w.uint32(42).string(m.toolName);
                if (m.toolSummary != null && $Object.hasOwnProperty.call(m, "toolSummary") && m.toolSummary !== "")
                    w.uint32(50).string(m.toolSummary);
                if (m.resolved != null && $Object.hasOwnProperty.call(m, "resolved") && m.resolved !== false)
                    w.uint32(56).bool(m.resolved);
                if (m.truncated != null && $Object.hasOwnProperty.call(m, "truncated") && m.truncated !== false)
                    w.uint32(64).bool(m.truncated);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            AppNotice.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.AppNotice();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.kind = v;
                            else
                                delete m.kind;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.title = v;
                            else
                                delete m.title;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.text = v;
                            else
                                delete m.text;
                            continue;
                        }
                    case 4: {
                            if (u !== 0)
                                break;
                            if (typeof (v = r.uint64()) === "object" ? v.low || v.high : v !== 0)
                                m.noticeId = v;
                            else
                                delete m.noticeId;
                            continue;
                        }
                    case 5: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.toolName = v;
                            else
                                delete m.toolName;
                            continue;
                        }
                    case 6: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.toolSummary = v;
                            else
                                delete m.toolSummary;
                            continue;
                        }
                    case 7: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.resolved = v;
                            else
                                delete m.resolved;
                            continue;
                        }
                    case 8: {
                            if (u !== 0)
                                break;
                            if (v = r.bool())
                                m.truncated = v;
                            else
                                delete m.truncated;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            AppNotice.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.AppNotice)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.AppNotice: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.AppNotice();
                if (d.kind != null) {
                    if (typeof d.kind !== "string" || d.kind.length) {
                        m.kind = $String(d.kind);
                    }
                }
                if (d.title != null) {
                    if (typeof d.title !== "string" || d.title.length) {
                        m.title = $String(d.title);
                    }
                }
                if (d.text != null) {
                    if (typeof d.text !== "string" || d.text.length) {
                        m.text = $String(d.text);
                    }
                }
                if (d.noticeId != null) {
                    if (typeof d.noticeId === "object" ? d.noticeId.low || d.noticeId.high : $Number(d.noticeId) !== 0) {
                        if ($util.Long)
                            m.noticeId = $util.Long.fromValue(d.noticeId, true);
                        else if (typeof d.noticeId === "string")
                            m.noticeId = $parseInt(d.noticeId, 10);
                        else if (typeof d.noticeId === "number")
                            m.noticeId = d.noticeId;
                        else if (typeof d.noticeId === "object")
                            m.noticeId = new $util.LongBits(d.noticeId.low >>> 0, d.noticeId.high >>> 0).toNumber(true);
                    }
                }
                if (d.toolName != null) {
                    if (typeof d.toolName !== "string" || d.toolName.length) {
                        m.toolName = $String(d.toolName);
                    }
                }
                if (d.toolSummary != null) {
                    if (typeof d.toolSummary !== "string" || d.toolSummary.length) {
                        m.toolSummary = $String(d.toolSummary);
                    }
                }
                if (d.resolved != null) {
                    if (d.resolved) {
                        m.resolved = $Boolean(d.resolved);
                    }
                }
                if (d.truncated != null) {
                    if (d.truncated) {
                        m.truncated = $Boolean(d.truncated);
                    }
                }
                return m;
            };

            AppNotice.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.kind = "";
                    d.title = "";
                    d.text = "";
                    if ($util.Long) {
                        var n = new $util.Long(0, 0, true);
                        d.noticeId = o.longs === $String ? n.toString() : o.longs === $Number ? n.toNumber() : typeof $BigInt !== "undefined" && o.longs === $BigInt ? n.toBigInt() : n;
                    } else
                        d.noticeId = o.longs === $String ? "0" : typeof $BigInt !== "undefined" && o.longs === $BigInt ? $BigInt("0") : 0;
                    d.toolName = "";
                    d.toolSummary = "";
                    d.resolved = false;
                    d.truncated = false;
                }
                if (m.kind != null && $Object.hasOwnProperty.call(m, "kind")) {
                    d.kind = m.kind;
                }
                if (m.title != null && $Object.hasOwnProperty.call(m, "title")) {
                    d.title = m.title;
                }
                if (m.text != null && $Object.hasOwnProperty.call(m, "text")) {
                    d.text = m.text;
                }
                if (m.noticeId != null && $Object.hasOwnProperty.call(m, "noticeId")) {
                    if (typeof $BigInt !== "undefined" && o.longs === $BigInt)
                        d.noticeId = typeof m.noticeId === "number" ? $BigInt(m.noticeId) : $util.Long.fromBits(m.noticeId.low >>> 0, m.noticeId.high >>> 0, true).toBigInt();
                    else if (typeof m.noticeId === "number")
                        d.noticeId = o.longs === $String ? $String(m.noticeId) : m.noticeId;
                    else
                        d.noticeId = o.longs === $String ? $util.Long.prototype.toString.call(m.noticeId) : o.longs === $Number ? new $util.LongBits(m.noticeId.low >>> 0, m.noticeId.high >>> 0).toNumber(true) : m.noticeId;
                }
                if (m.toolName != null && $Object.hasOwnProperty.call(m, "toolName")) {
                    d.toolName = m.toolName;
                }
                if (m.toolSummary != null && $Object.hasOwnProperty.call(m, "toolSummary")) {
                    d.toolSummary = m.toolSummary;
                }
                if (m.resolved != null && $Object.hasOwnProperty.call(m, "resolved")) {
                    d.resolved = m.resolved;
                }
                if (m.truncated != null && $Object.hasOwnProperty.call(m, "truncated")) {
                    d.truncated = m.truncated;
                }
                return d;
            };

            AppNotice.prototype.toJSON = function() {
                return AppNotice.toObject(this, $protobuf.util.toJSONOptions);
            };

            AppNotice.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.AppNotice";
            };

            return AppNotice;
        })();

        v1.CommandListReq = (function() {

            const CommandListReq = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            CommandListReq.create = function(properties) {
                return new CommandListReq(properties);
            };

            CommandListReq.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            CommandListReq.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.CommandListReq();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    r.skipType(t & 7, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            CommandListReq.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.CommandListReq)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.CommandListReq: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                return new $root.rterm.v1.CommandListReq();
            };

            CommandListReq.toObject = function () {
                return {};
            };

            CommandListReq.prototype.toJSON = function() {
                return CommandListReq.toObject(this, $protobuf.util.toJSONOptions);
            };

            CommandListReq.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.CommandListReq";
            };

            return CommandListReq;
        })();

        v1.CommandList = (function() {

            const CommandList = function (p) {
                this.commands = [];
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            CommandList.prototype.commands = $util.emptyArray;

            CommandList.create = function(properties) {
                return new CommandList(properties);
            };

            CommandList.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.commands != null && m.commands.length) {
                    for (var i = 0; i < m.commands.length; ++i)
                        $root.rterm.v1.CustomCommand.encode(m.commands[i], w.uint32(10).fork(), q + 1).ldelim();
                }
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            CommandList.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.CommandList();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if (!(m.commands && m.commands.length))
                                m.commands = [];
                            m.commands.push($root.rterm.v1.CustomCommand.decode(r, r.size(), $undefined, q + 1));
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            CommandList.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.CommandList)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.CommandList: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.CommandList();
                if (d.commands) {
                    if (!$Array.isArray(d.commands))
                        throw $TypeError(".rterm.v1.CommandList.commands: array expected");
                    m.commands = $Array(d.commands.length);
                    for (var i = 0; i < d.commands.length; ++i) {
                        if (!$util.isObject(d.commands[i]))
                            throw $TypeError(".rterm.v1.CommandList.commands: object expected");
                        m.commands[i] = $root.rterm.v1.CustomCommand.fromObject(d.commands[i], q + 1);
                    }
                }
                return m;
            };

            CommandList.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.arrays || o.defaults) {
                    d.commands = [];
                }
                if (m.commands && m.commands.length) {
                    d.commands = $Array(m.commands.length);
                    for (var j = 0; j < m.commands.length; ++j) {
                        d.commands[j] = $root.rterm.v1.CustomCommand.toObject(m.commands[j], o, q + 1);
                    }
                }
                return d;
            };

            CommandList.prototype.toJSON = function() {
                return CommandList.toObject(this, $protobuf.util.toJSONOptions);
            };

            CommandList.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.CommandList";
            };

            return CommandList;
        })();

        v1.CustomCommand = (function() {

            const CustomCommand = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            CustomCommand.prototype.name = "";
            CustomCommand.prototype.description = "";
            CustomCommand.prototype.argumentHint = "";
            CustomCommand.prototype.source = "";

            CustomCommand.create = function(properties) {
                return new CustomCommand(properties);
            };

            CustomCommand.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.name != null && $Object.hasOwnProperty.call(m, "name") && m.name !== "")
                    w.uint32(10).string(m.name);
                if (m.description != null && $Object.hasOwnProperty.call(m, "description") && m.description !== "")
                    w.uint32(18).string(m.description);
                if (m.argumentHint != null && $Object.hasOwnProperty.call(m, "argumentHint") && m.argumentHint !== "")
                    w.uint32(26).string(m.argumentHint);
                if (m.source != null && $Object.hasOwnProperty.call(m, "source") && m.source !== "")
                    w.uint32(34).string(m.source);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            CustomCommand.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.CustomCommand();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.name = v;
                            else
                                delete m.name;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.description = v;
                            else
                                delete m.description;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.argumentHint = v;
                            else
                                delete m.argumentHint;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.source = v;
                            else
                                delete m.source;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            CustomCommand.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.CustomCommand)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.CustomCommand: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.CustomCommand();
                if (d.name != null) {
                    if (typeof d.name !== "string" || d.name.length) {
                        m.name = $String(d.name);
                    }
                }
                if (d.description != null) {
                    if (typeof d.description !== "string" || d.description.length) {
                        m.description = $String(d.description);
                    }
                }
                if (d.argumentHint != null) {
                    if (typeof d.argumentHint !== "string" || d.argumentHint.length) {
                        m.argumentHint = $String(d.argumentHint);
                    }
                }
                if (d.source != null) {
                    if (typeof d.source !== "string" || d.source.length) {
                        m.source = $String(d.source);
                    }
                }
                return m;
            };

            CustomCommand.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.name = "";
                    d.description = "";
                    d.argumentHint = "";
                    d.source = "";
                }
                if (m.name != null && $Object.hasOwnProperty.call(m, "name")) {
                    d.name = m.name;
                }
                if (m.description != null && $Object.hasOwnProperty.call(m, "description")) {
                    d.description = m.description;
                }
                if (m.argumentHint != null && $Object.hasOwnProperty.call(m, "argumentHint")) {
                    d.argumentHint = m.argumentHint;
                }
                if (m.source != null && $Object.hasOwnProperty.call(m, "source")) {
                    d.source = m.source;
                }
                return d;
            };

            CustomCommand.prototype.toJSON = function() {
                return CustomCommand.toObject(this, $protobuf.util.toJSONOptions);
            };

            CustomCommand.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.CustomCommand";
            };

            return CustomCommand;
        })();

        v1.LaunchOptions = (function() {

            const LaunchOptions = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            LaunchOptions.prototype.model = "";
            LaunchOptions.prototype.permissionMode = "";
            LaunchOptions.prototype.effort = "";
            LaunchOptions.prototype.resume = "";
            LaunchOptions.prototype.sessionName = "";

            LaunchOptions.create = function(properties) {
                return new LaunchOptions(properties);
            };

            LaunchOptions.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.model != null && $Object.hasOwnProperty.call(m, "model") && m.model !== "")
                    w.uint32(10).string(m.model);
                if (m.permissionMode != null && $Object.hasOwnProperty.call(m, "permissionMode") && m.permissionMode !== "")
                    w.uint32(18).string(m.permissionMode);
                if (m.effort != null && $Object.hasOwnProperty.call(m, "effort") && m.effort !== "")
                    w.uint32(26).string(m.effort);
                if (m.resume != null && $Object.hasOwnProperty.call(m, "resume") && m.resume !== "")
                    w.uint32(34).string(m.resume);
                if (m.sessionName != null && $Object.hasOwnProperty.call(m, "sessionName") && m.sessionName !== "")
                    w.uint32(42).string(m.sessionName);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            LaunchOptions.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.LaunchOptions();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.model = v;
                            else
                                delete m.model;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.permissionMode = v;
                            else
                                delete m.permissionMode;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.effort = v;
                            else
                                delete m.effort;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.resume = v;
                            else
                                delete m.resume;
                            continue;
                        }
                    case 5: {
                            if (u !== 2)
                                break;
                            if ((v = r.stringVerify()).length)
                                m.sessionName = v;
                            else
                                delete m.sessionName;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            LaunchOptions.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.LaunchOptions)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.LaunchOptions: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.LaunchOptions();
                if (d.model != null) {
                    if (typeof d.model !== "string" || d.model.length) {
                        m.model = $String(d.model);
                    }
                }
                if (d.permissionMode != null) {
                    if (typeof d.permissionMode !== "string" || d.permissionMode.length) {
                        m.permissionMode = $String(d.permissionMode);
                    }
                }
                if (d.effort != null) {
                    if (typeof d.effort !== "string" || d.effort.length) {
                        m.effort = $String(d.effort);
                    }
                }
                if (d.resume != null) {
                    if (typeof d.resume !== "string" || d.resume.length) {
                        m.resume = $String(d.resume);
                    }
                }
                if (d.sessionName != null) {
                    if (typeof d.sessionName !== "string" || d.sessionName.length) {
                        m.sessionName = $String(d.sessionName);
                    }
                }
                return m;
            };

            LaunchOptions.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.model = "";
                    d.permissionMode = "";
                    d.effort = "";
                    d.resume = "";
                    d.sessionName = "";
                }
                if (m.model != null && $Object.hasOwnProperty.call(m, "model")) {
                    d.model = m.model;
                }
                if (m.permissionMode != null && $Object.hasOwnProperty.call(m, "permissionMode")) {
                    d.permissionMode = m.permissionMode;
                }
                if (m.effort != null && $Object.hasOwnProperty.call(m, "effort")) {
                    d.effort = m.effort;
                }
                if (m.resume != null && $Object.hasOwnProperty.call(m, "resume")) {
                    d.resume = m.resume;
                }
                if (m.sessionName != null && $Object.hasOwnProperty.call(m, "sessionName")) {
                    d.sessionName = m.sessionName;
                }
                return d;
            };

            LaunchOptions.prototype.toJSON = function() {
                return LaunchOptions.toObject(this, $protobuf.util.toJSONOptions);
            };

            LaunchOptions.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.LaunchOptions";
            };

            return LaunchOptions;
        })();

        v1.Handshake = (function() {

            const Handshake = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            Handshake.prototype.init = null;
            Handshake.prototype.resp = null;
            Handshake.prototype.confirm = null;

            let $oneOfFields;

            $Object.defineProperty(Handshake.prototype, "body", {
                get: $util.oneOfGetter($oneOfFields = ["init", "resp", "confirm"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            Handshake.create = function(properties) {
                return new Handshake(properties);
            };

            Handshake.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.init != null && $Object.hasOwnProperty.call(m, "init"))
                    $root.rterm.v1.PakeInit.encode(m.init, w.uint32(10).fork(), q + 1).ldelim();
                if (m.resp != null && $Object.hasOwnProperty.call(m, "resp"))
                    $root.rterm.v1.PakeResp.encode(m.resp, w.uint32(18).fork(), q + 1).ldelim();
                if (m.confirm != null && $Object.hasOwnProperty.call(m, "confirm"))
                    $root.rterm.v1.PakeConfirm.encode(m.confirm, w.uint32(26).fork(), q + 1).ldelim();
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            Handshake.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.Handshake();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            m.init = $root.rterm.v1.PakeInit.decode(r, r.size(), $undefined, q + 1, m.init);
                            m.body = "init";
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            m.resp = $root.rterm.v1.PakeResp.decode(r, r.size(), $undefined, q + 1, m.resp);
                            m.body = "resp";
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            m.confirm = $root.rterm.v1.PakeConfirm.decode(r, r.size(), $undefined, q + 1, m.confirm);
                            m.body = "confirm";
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            Handshake.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.Handshake)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.Handshake: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.Handshake();
                if (d.init != null) {
                    if (!$util.isObject(d.init))
                        throw $TypeError(".rterm.v1.Handshake.init: object expected");
                    m.init = $root.rterm.v1.PakeInit.fromObject(d.init, q + 1);
                }
                if (d.resp != null) {
                    if (!$util.isObject(d.resp))
                        throw $TypeError(".rterm.v1.Handshake.resp: object expected");
                    m.resp = $root.rterm.v1.PakeResp.fromObject(d.resp, q + 1);
                }
                if (d.confirm != null) {
                    if (!$util.isObject(d.confirm))
                        throw $TypeError(".rterm.v1.Handshake.confirm: object expected");
                    m.confirm = $root.rterm.v1.PakeConfirm.fromObject(d.confirm, q + 1);
                }
                return m;
            };

            Handshake.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (m.init != null && $Object.hasOwnProperty.call(m, "init")) {
                    d.init = $root.rterm.v1.PakeInit.toObject(m.init, o, q + 1);
                    if (o.oneofs)
                        d.body = "init";
                }
                if (m.resp != null && $Object.hasOwnProperty.call(m, "resp")) {
                    d.resp = $root.rterm.v1.PakeResp.toObject(m.resp, o, q + 1);
                    if (o.oneofs)
                        d.body = "resp";
                }
                if (m.confirm != null && $Object.hasOwnProperty.call(m, "confirm")) {
                    d.confirm = $root.rterm.v1.PakeConfirm.toObject(m.confirm, o, q + 1);
                    if (o.oneofs)
                        d.body = "confirm";
                }
                return d;
            };

            Handshake.prototype.toJSON = function() {
                return Handshake.toObject(this, $protobuf.util.toJSONOptions);
            };

            Handshake.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.Handshake";
            };

            return Handshake;
        })();

        v1.PakeInit = (function() {

            const PakeInit = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            PakeInit.prototype.protoVer = 0;
            PakeInit.prototype.spakeMsg = $util.newBuffer([]);
            PakeInit.prototype.publicKey = $util.newBuffer([]);
            PakeInit.prototype.nonce = $util.newBuffer([]);
            PakeInit.prototype.passwordKind = 0;

            PakeInit.create = function(properties) {
                return new PakeInit(properties);
            };

            PakeInit.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.protoVer != null && $Object.hasOwnProperty.call(m, "protoVer") && m.protoVer !== 0)
                    w.uint32(8).uint32(m.protoVer);
                if (m.spakeMsg != null && $Object.hasOwnProperty.call(m, "spakeMsg") && m.spakeMsg.length)
                    w.uint32(18).bytes(m.spakeMsg);
                if (m.publicKey != null && $Object.hasOwnProperty.call(m, "publicKey") && m.publicKey.length)
                    w.uint32(26).bytes(m.publicKey);
                if (m.nonce != null && $Object.hasOwnProperty.call(m, "nonce") && m.nonce.length)
                    w.uint32(34).bytes(m.nonce);
                if (m.passwordKind != null && $Object.hasOwnProperty.call(m, "passwordKind") && m.passwordKind !== 0)
                    w.uint32(40).uint32(m.passwordKind);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            PakeInit.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.PakeInit();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.protoVer = v;
                            else
                                delete m.protoVer;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.spakeMsg = v;
                            else
                                delete m.spakeMsg;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.publicKey = v;
                            else
                                delete m.publicKey;
                            continue;
                        }
                    case 4: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.nonce = v;
                            else
                                delete m.nonce;
                            continue;
                        }
                    case 5: {
                            if (u !== 0)
                                break;
                            if (v = r.uint32())
                                m.passwordKind = v;
                            else
                                delete m.passwordKind;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            PakeInit.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.PakeInit)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.PakeInit: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.PakeInit();
                if (d.protoVer != null) {
                    if ($Number(d.protoVer) !== 0) {
                        m.protoVer = d.protoVer >>> 0;
                    }
                }
                if (d.spakeMsg != null) {
                    if (d.spakeMsg.length) {
                        if (typeof d.spakeMsg === "string")
                            $util.base64.decode(d.spakeMsg, m.spakeMsg = $util.newBuffer($util.base64.length(d.spakeMsg)), 0);
                        else if (d.spakeMsg.length >= 0)
                            m.spakeMsg = d.spakeMsg;
                    }
                }
                if (d.publicKey != null) {
                    if (d.publicKey.length) {
                        if (typeof d.publicKey === "string")
                            $util.base64.decode(d.publicKey, m.publicKey = $util.newBuffer($util.base64.length(d.publicKey)), 0);
                        else if (d.publicKey.length >= 0)
                            m.publicKey = d.publicKey;
                    }
                }
                if (d.nonce != null) {
                    if (d.nonce.length) {
                        if (typeof d.nonce === "string")
                            $util.base64.decode(d.nonce, m.nonce = $util.newBuffer($util.base64.length(d.nonce)), 0);
                        else if (d.nonce.length >= 0)
                            m.nonce = d.nonce;
                    }
                }
                if (d.passwordKind != null) {
                    if ($Number(d.passwordKind) !== 0) {
                        m.passwordKind = d.passwordKind >>> 0;
                    }
                }
                return m;
            };

            PakeInit.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    d.protoVer = 0;
                    if (o.bytes === $String)
                        d.spakeMsg = "";
                    else {
                        d.spakeMsg = [];
                        if (o.bytes !== $Array)
                            d.spakeMsg = $util.newBuffer(d.spakeMsg);
                    }
                    if (o.bytes === $String)
                        d.publicKey = "";
                    else {
                        d.publicKey = [];
                        if (o.bytes !== $Array)
                            d.publicKey = $util.newBuffer(d.publicKey);
                    }
                    if (o.bytes === $String)
                        d.nonce = "";
                    else {
                        d.nonce = [];
                        if (o.bytes !== $Array)
                            d.nonce = $util.newBuffer(d.nonce);
                    }
                    d.passwordKind = 0;
                }
                if (m.protoVer != null && $Object.hasOwnProperty.call(m, "protoVer")) {
                    d.protoVer = m.protoVer;
                }
                if (m.spakeMsg != null && $Object.hasOwnProperty.call(m, "spakeMsg")) {
                    d.spakeMsg = o.bytes === $String ? $util.base64.encode(m.spakeMsg, 0, m.spakeMsg.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.spakeMsg) : m.spakeMsg;
                }
                if (m.publicKey != null && $Object.hasOwnProperty.call(m, "publicKey")) {
                    d.publicKey = o.bytes === $String ? $util.base64.encode(m.publicKey, 0, m.publicKey.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.publicKey) : m.publicKey;
                }
                if (m.nonce != null && $Object.hasOwnProperty.call(m, "nonce")) {
                    d.nonce = o.bytes === $String ? $util.base64.encode(m.nonce, 0, m.nonce.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.nonce) : m.nonce;
                }
                if (m.passwordKind != null && $Object.hasOwnProperty.call(m, "passwordKind")) {
                    d.passwordKind = m.passwordKind;
                }
                return d;
            };

            PakeInit.prototype.toJSON = function() {
                return PakeInit.toObject(this, $protobuf.util.toJSONOptions);
            };

            PakeInit.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.PakeInit";
            };

            return PakeInit;
        })();

        v1.PakeResp = (function() {

            const PakeResp = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            PakeResp.prototype.spakeMsg = $util.newBuffer([]);
            PakeResp.prototype.publicKey = $util.newBuffer([]);
            PakeResp.prototype.nonce = $util.newBuffer([]);

            PakeResp.create = function(properties) {
                return new PakeResp(properties);
            };

            PakeResp.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.spakeMsg != null && $Object.hasOwnProperty.call(m, "spakeMsg") && m.spakeMsg.length)
                    w.uint32(10).bytes(m.spakeMsg);
                if (m.publicKey != null && $Object.hasOwnProperty.call(m, "publicKey") && m.publicKey.length)
                    w.uint32(18).bytes(m.publicKey);
                if (m.nonce != null && $Object.hasOwnProperty.call(m, "nonce") && m.nonce.length)
                    w.uint32(26).bytes(m.nonce);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            PakeResp.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.PakeResp();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.spakeMsg = v;
                            else
                                delete m.spakeMsg;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.publicKey = v;
                            else
                                delete m.publicKey;
                            continue;
                        }
                    case 3: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.nonce = v;
                            else
                                delete m.nonce;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            PakeResp.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.PakeResp)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.PakeResp: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.PakeResp();
                if (d.spakeMsg != null) {
                    if (d.spakeMsg.length) {
                        if (typeof d.spakeMsg === "string")
                            $util.base64.decode(d.spakeMsg, m.spakeMsg = $util.newBuffer($util.base64.length(d.spakeMsg)), 0);
                        else if (d.spakeMsg.length >= 0)
                            m.spakeMsg = d.spakeMsg;
                    }
                }
                if (d.publicKey != null) {
                    if (d.publicKey.length) {
                        if (typeof d.publicKey === "string")
                            $util.base64.decode(d.publicKey, m.publicKey = $util.newBuffer($util.base64.length(d.publicKey)), 0);
                        else if (d.publicKey.length >= 0)
                            m.publicKey = d.publicKey;
                    }
                }
                if (d.nonce != null) {
                    if (d.nonce.length) {
                        if (typeof d.nonce === "string")
                            $util.base64.decode(d.nonce, m.nonce = $util.newBuffer($util.base64.length(d.nonce)), 0);
                        else if (d.nonce.length >= 0)
                            m.nonce = d.nonce;
                    }
                }
                return m;
            };

            PakeResp.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if (o.bytes === $String)
                        d.spakeMsg = "";
                    else {
                        d.spakeMsg = [];
                        if (o.bytes !== $Array)
                            d.spakeMsg = $util.newBuffer(d.spakeMsg);
                    }
                    if (o.bytes === $String)
                        d.publicKey = "";
                    else {
                        d.publicKey = [];
                        if (o.bytes !== $Array)
                            d.publicKey = $util.newBuffer(d.publicKey);
                    }
                    if (o.bytes === $String)
                        d.nonce = "";
                    else {
                        d.nonce = [];
                        if (o.bytes !== $Array)
                            d.nonce = $util.newBuffer(d.nonce);
                    }
                }
                if (m.spakeMsg != null && $Object.hasOwnProperty.call(m, "spakeMsg")) {
                    d.spakeMsg = o.bytes === $String ? $util.base64.encode(m.spakeMsg, 0, m.spakeMsg.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.spakeMsg) : m.spakeMsg;
                }
                if (m.publicKey != null && $Object.hasOwnProperty.call(m, "publicKey")) {
                    d.publicKey = o.bytes === $String ? $util.base64.encode(m.publicKey, 0, m.publicKey.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.publicKey) : m.publicKey;
                }
                if (m.nonce != null && $Object.hasOwnProperty.call(m, "nonce")) {
                    d.nonce = o.bytes === $String ? $util.base64.encode(m.nonce, 0, m.nonce.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.nonce) : m.nonce;
                }
                return d;
            };

            PakeResp.prototype.toJSON = function() {
                return PakeResp.toObject(this, $protobuf.util.toJSONOptions);
            };

            PakeResp.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.PakeResp";
            };

            return PakeResp;
        })();

        v1.PakeConfirm = (function() {

            const PakeConfirm = function (p) {
                if (p)
                    for (var ks = $Object.keys(p), i = 0; i < ks.length; ++i)
                        if (p[ks[i]] != null && ks[i] !== "__proto__")
                            this[ks[i]] = p[ks[i]];
            };

            PakeConfirm.prototype.mac = $util.newBuffer([]);
            PakeConfirm.prototype.signature = $util.newBuffer([]);

            PakeConfirm.create = function(properties) {
                return new PakeConfirm(properties);
            };

            PakeConfirm.encode = function (m, w, q) {
                if (!w)
                    w = $Writer.create();
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                if (m.mac != null && $Object.hasOwnProperty.call(m, "mac") && m.mac.length)
                    w.uint32(10).bytes(m.mac);
                if (m.signature != null && $Object.hasOwnProperty.call(m, "signature") && m.signature.length)
                    w.uint32(18).bytes(m.signature);
                if (m.$unknowns != null && $Object.hasOwnProperty.call(m, "$unknowns"))
                    for (var i = 0; i < m.$unknowns.length; ++i)
                        w.raw(m.$unknowns[i]);
                return w;
            };

            PakeConfirm.decode = function (r, l, z, q, g) {
                if (!(r instanceof $Reader))
                    r = $Reader.create(r);
                if (q === $undefined)
                    q = 0;
                if (q > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                var c, m, v;
                if (l === $undefined)
                    c = r.len;
                else {
                    c = r.pos + l;
                    if (c > r.len)
                        throw $RangeError("index out of range");
                    l = r.len;
                    r.len = c;
                }
                m = g || new $root.rterm.v1.PakeConfirm();
                while (r.pos < c) {
                    var s = r.pos;
                    var t = r.tag();
                    if (t === z) {
                        z = $undefined;
                        break;
                    }
                    var u = t & 7;
                    switch (t >>>= 3) {
                    case 1: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.mac = v;
                            else
                                delete m.mac;
                            continue;
                        }
                    case 2: {
                            if (u !== 2)
                                break;
                            if ((v = r.bytes()).length)
                                m.signature = v;
                            else
                                delete m.signature;
                            continue;
                        }
                    }
                    r.skipType(u, q, t);
                    if (!r.discardUnknown) {
                        $util.makeProp(m, "$unknowns", false);
                        (m.$unknowns || (m.$unknowns = [])).push(r.raw(s, r.pos));
                    }
                }
                if (l !== $undefined) {
                    if (r.pos !== c)
                        throw $RangeError("index out of range");
                    r.len = l;
                }
                if (z !== $undefined)
                    throw $Error("missing end group");
                return m;
            };

            PakeConfirm.fromObject = function (d, q) {
                if (d instanceof $root.rterm.v1.PakeConfirm)
                    return d;
                if (!$util.isObject(d))
                    throw $TypeError(".rterm.v1.PakeConfirm: object expected");
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var m = new $root.rterm.v1.PakeConfirm();
                if (d.mac != null) {
                    if (d.mac.length) {
                        if (typeof d.mac === "string")
                            $util.base64.decode(d.mac, m.mac = $util.newBuffer($util.base64.length(d.mac)), 0);
                        else if (d.mac.length >= 0)
                            m.mac = d.mac;
                    }
                }
                if (d.signature != null) {
                    if (d.signature.length) {
                        if (typeof d.signature === "string")
                            $util.base64.decode(d.signature, m.signature = $util.newBuffer($util.base64.length(d.signature)), 0);
                        else if (d.signature.length >= 0)
                            m.signature = d.signature;
                    }
                }
                return m;
            };

            PakeConfirm.toObject = function (m, o, q) {
                if (!o)
                    o = {};
                if (q === $undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw $Error("max depth exceeded");
                var d = {};
                if (o.defaults) {
                    if (o.bytes === $String)
                        d.mac = "";
                    else {
                        d.mac = [];
                        if (o.bytes !== $Array)
                            d.mac = $util.newBuffer(d.mac);
                    }
                    if (o.bytes === $String)
                        d.signature = "";
                    else {
                        d.signature = [];
                        if (o.bytes !== $Array)
                            d.signature = $util.newBuffer(d.signature);
                    }
                }
                if (m.mac != null && $Object.hasOwnProperty.call(m, "mac")) {
                    d.mac = o.bytes === $String ? $util.base64.encode(m.mac, 0, m.mac.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.mac) : m.mac;
                }
                if (m.signature != null && $Object.hasOwnProperty.call(m, "signature")) {
                    d.signature = o.bytes === $String ? $util.base64.encode(m.signature, 0, m.signature.length) : o.bytes === $Array ? $Array.prototype.slice.call(m.signature) : m.signature;
                }
                return d;
            };

            PakeConfirm.prototype.toJSON = function() {
                return PakeConfirm.toObject(this, $protobuf.util.toJSONOptions);
            };

            PakeConfirm.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/rterm.v1.PakeConfirm";
            };

            return PakeConfirm;
        })();

        return v1;
    })();

    return rterm;
})();

export {
  $root as default
};
