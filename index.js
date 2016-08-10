"use strict";
/**
 * Module dependencies.
 */

//var debug = require('debug')('socket.io-parser');
const Emitter = require('events');
const binary = require('./binary');
const isBuf = require('./is-buffer');

/**
 * Protocol version.
 *
 * @api public
 */

const protocol = module.exports.protocol = Number(4);

/**
 * Packet types.
 *
 * @api public
 */

const Types = module.exports.types = [
  'CONNECT',
  'DISCONNECT',
  'EVENT',
  'ACK',
  'ERROR',
  'BINARY_EVENT',
  'BINARY_ACK'
];

/** Packet type `connect`.
 * @api public
 */
const CONNECT = module.exports.CONNECT = Number(0);
/** Packet type `disconnect`.
 * @api public
 */
const DISCONNECT = module.exports.DISCONNECT = Number(1);
/** Packet type `event`.
 * @api public
 */
const EVENT = module.exports.EVENT = Number(2);
/** Packet type `ack`.
 * @api public
 */
const ACK = module.exports.ACK = Number(3);
/** Packet type `error`.
 * @api public
 */
const ERROR = module.exports.ERROR = Number(4);
/** Packet type 'binary event'
 * @api public
 */
const BINARY_EVENT = module.exports.BINARY_EVENT = Number(5);
/** Packet type `binary ack`. For acks with binary arguments.
 * @api public
 */
const BINARY_ACK = module.exports.BINARY_ACK = Number(6);

/**
 * A manager of a binary event's 'buffer sequence'. Should
 * be constructed whenever a packet of type BINARY_EVENT is
 * decoded.
 *
 * @param {Object} packet
 * @constructor
 * @type {{new(*): {finishedReconstruction, takeBinaryData: (function((Buffer|ArrayBuffer)): (null|Object))}}}
 * @return {BinaryReconstructor} initialized reconstructor
 * @api private
 */
const BinaryReconstructor = class BinaryReconstructor{
  constructor(packet) {
    this.reconPack = packet;
    this.buffers = [];
  }

  /**
   * Method to be called when binary data received from connection
   * after a BINARY_EVENT packet.
   *
   * @param {Buffer | ArrayBuffer} binData - the raw binary data received
   * @return {null | Object} returns null if more binary data is expected or
   *   a reconstructed packet object if all buffers have been received.
   * @api private
   */
  takeBinaryData(binData) {
    this.buffers.push(binData);
    if (this.buffers.length == this.reconPack.attachments) { // done with buffer list
      const packet = binary.reconstructPacket(this.reconPack, this.buffers);
      this.finishedReconstruction();
      return packet;
    }
    return null;
  }
  /**
   * Cleans up binary packet reconstruction variables.
   *
   * @api private
   */
  finishedReconstruction () {
    this.reconPack = null;
    this.buffers = [];
  }
};

/**
 * A socket.io Encoder instance
 * @constructor
 * @api public
 */
const Encoder = module.exports.Encoder = class Encoder{
  constructor() {}

  /**
   * Encode a packet as a single string if non-binary, or as a
   * buffer sequence, depending on packet type.
   *
   * @param {Object} obj - packet object
   * @param {Function} callback - function to handle encodings (likely engine.write)
   * @return Calls callback with Array of encodings
   * @api public
   */
  encode(obj, callback) {
    const encoding = Encoder.encodeAsString(obj);
    callback([encoding]);
  }
  encodeBinary(obj, callback){
    Encoder.encodeAsBinary(obj, callback);
  }
  /**
   * Encode packet as string.
   *
   * @param {Object} packet
   * @return {String} encoded
   * @api private
   */

  static encodeAsString(obj) {
    let str = String('');
    let nsp = false;
    // first is type
    str += obj.type;

    // attachments if we have them
    if (BINARY_EVENT === obj.type || BINARY_ACK === obj.type) {
      str += obj.attachments;
      str += '-';
    }

    // if we have a namespace other than `/`
    // we append it followed by a comma `,`
    if (obj.nsp && '/' !== obj.nsp) {
      nsp = true;
      str += obj.nsp;
    }

    // immediately followed by the id
    if (undefined !== obj.id) {
      if (nsp) {
        str += ',';
        nsp = false;
      }
      str += obj.id;
    }

    // json data
    if (undefined !== obj.data) {
      if (nsp) str += ',';
      str += JSON.stringify(obj.data);
    }
    return str;
  }
  /**
   * Encode packet as 'buffer sequence' by removing blobs, and
   * deconstructing packet into object with placeholders and
   * a list of buffers.
   *
   * @param {Object} packet
   * @return {Buffer} encoded
   * @api private
   */

   static encodeAsBinary(obj, callback) {
    function writeEncoding(bloblessData) {
      var deconstruction = binary.deconstructPacket(bloblessData);
      var pack = this.encodeAsString(deconstruction.packet);
      var buffers = deconstruction.buffers;

      buffers.unshift(pack); // add packet info to beginning of data list
      callback(buffers); // write all the buffers
    }

    binary.removeBlobs(obj, writeEncoding);
  }
};

/**
 * A socket.io Decoder instance
 * @constructor
 * @return {Object} decoder
 * @api public
 */
const Decoder = module.exports.Decoder = class Decoder extends Emitter {
  constructor(){
    super();
    this.reconstructor = null;
  }
  /**
   * Decodes an ecoded packet string into packet JSON.
   *
   * @param {String} obj - encoded packet
   * @return {Object} packet
   * @api public
   */
  addBinary(obj){
    if (isBuf(obj) || obj.base64) { // raw binary data
      if (!this.reconstructor) {
        throw new Error('got binary data when not reconstructing a packet');
      } else {
        packet = this.reconstructor.takeBinaryData(obj);
        if (packet) { // received final buffer
          this.reconstructor = null;
          this.emit('decoded', packet);
        }
      }
    }
  }
  addWithBinary(obj){
    let packet;
    if ('string' === typeof obj) {
      packet = Decoder.decodeString(obj);
      this.reconstructor = new BinaryReconstructor(packet);
        
      // no attachments, labeled binary but no binary data to follow
      if (this.reconstructor.reconPack.attachments === 0) {
        this.emit('decoded', packet);
      }
    } else throw new Error('Unknown type: ' + obj);
  }
  add (obj) {
    if ('string' === typeof obj) {
      this.emit('decoded', Decoder.decodeString(obj) );
    } else throw new Error('Unknown type: ' + obj);
  }
  /**
   * Deallocates a parser's resources
   *
   * @api public
   */
  destroy() {
    if (this.reconstructor) {
      this.reconstructor.finishedReconstruction();
    }
  }
  /**
   * Decode a packet String (JSON data)
   *
   * @param {String} str
   * @return {Object} packet
   * @api private
   */

   static decodeString(str) {
    let p = {
      type: undefined
    };
    let index = 0;
    // look up type
    p.type = parseInt(str[0]);
    if (Types[p.type] === undefined) return { type: ERROR,  data: 'parser error' };

    // look up attachments if type binary
    if (BINARY_EVENT === p.type || BINARY_ACK === p.type) {
      let buf = String('');

      for (let i = 1, l = str.length; i < l; i++){
        if (str[i] !== '-') buf += str[i];
        else { index = i; break; }
      }

      if (buf != parseInt(buf) || str[index] !== '-') {
        throw new Error('Illegal attachments');
      }
      p.attachments = parseInt(buf);
    }

    // look up namespace (if any)
    if ('/' === str[index + 1]) {
      index += 1;
      p.nsp = String('');
      for (let i = index, l = str.length; i < l; i++){
        if (str[i] === ',') { index = i; break };
        p.nsp += str[i];
      }
    } else {
      p.nsp = '/';
    }

    // look up id
    index += 1;
    let id = parseInt(str[index]);

    if ( Number.isInteger(id) ){
      p.id = '';
      for (let i = index, l = str.length; i < l; i++){
        if (parseInt(str[i]) == str[i]) p.id += str[i];
        else { index = i; break;}
      }
      p.id = parseInt(p.id);
    }

    // look up json data
    if (str[index]) {
      p.data = JSON.parse(str.substr(index));
    }
    return p;
  }
};
