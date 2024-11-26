import { computeCrc, crcLookupTable } from "./crc.mjs";

const encoder = new TextEncoder('utf-8')
const decoder = new TextDecoder();

export class ITXtChunkEncoder {
  static predefinedKeywords = new Set([
   "Title",            // Short (one line) title or caption for image
   "Author",           // Name of image's creator
   "Description",      // Description of image (possibly long)
   "Copyright",        // Copyright notice
   "Creation Time",    // Time of original image creation
   "Software",         // Software used to create the image
   "Disclaimer",       // Legal disclaimer
   "Warning",          // Warning of nature of content
   "Source",           // Device used to create the image
   "Comment",          // Miscellaneous comment
  ])

  constructor(language="en", compression=0) {
    // The compression method field is provided for possible future expansion or
    // proprietary variants
    this.compressionMethod = 0;
    this.compressionFlag = new Uint8Array([compression]); // 0 for uncompressed, 1 for compressed
    this.languageEncoded = encoder.encode(language);
  }
  getChunk(text="", keyword="Comment", translatedKeyword="") {
    const nullSeparator = new Uint8Array([0]);
    const textEncoded = encoder.encode(text);
    const keywordEncoded = encoder.encode(keyword);
    const translatedKeywordEncoded = encoder.encode(translatedKeyword || keyword);
    const typeEncoded = encoder.encode('iTXt');

    /* Chunk data format:
       Keyword:             1-79 bytes (character string)
       Null separator:      1 byte
       Compression flag:    1 byte
       Compression method:  1 byte
       Language tag:        0 or more bytes (character string)
       Null separator:      1 byte
       Translated keyword:  0 or more bytes
       Null separator:      1 byte
       Text:                0 or more bytes
    */

    // The parts of the chunk excepting the type, length and crc
    const dataParts = [
      keywordEncoded,
      nullSeparator,
      this.compressionFlag,
      this.languageEncoded,
      nullSeparator,
      translatedKeywordEncoded,
      nullSeparator,
      textEncoded
    ];

    /*
      Build the full chunk:
      Length:     4-byte unsigned integer giving the number of bytes in the chunk's data
                  field. The length counts only the data field, not itself, the chunk
                  type code, or the CRC.
      Chunk Type: 4-byte chunk type code. iTXT in this case
      Chunk Data: Data bytes appropriate to the chunk type. 0-n length (suggested max 1024 bytes)
      CRC:        4-byte CRC (Cyclic Redundancy Check)
                  sum of the bytes in the chunk, including the chunk type code and chunk data
    */
    const crcValue = computeCrc(new Uint8Array([typeEncoded, ...dataParts]));
    // Calculate the length of the chunk (not including the length or CRC fields)
    const dataLength = dataParts.reduce((sum, part) => sum + part.length, 0);

    // Combine all parts into one Uint8Array
    const chunkData = new Uint8Array(dataLength);
    let offset = 0;
    for (let part of dataParts) {
      chunkData.set(part, offset);
      offset += part.length;
    };

    const chunkSize = 4 // bytes for the length
                    + 4 // type ("iTXT" encoded)
                    + chunkData.length
                    + 4 // The CRC
                    ;
    const chunk = new Uint8Array(chunkSize);

    new DataView(chunk.buffer).setUint32(0, dataLength); // Set the length at the beginning
    chunk.set(typeEncoded, 4);                       // Set the chunk type
    chunk.set(chunkData, 8);                         // Set the actual data
    new DataView(chunk.buffer).setUint32(4 + 4 + dataLength, crcValue, false); // CRC at the end

    return chunk;
  }
}

export function getChunkAtIndex(imgBuffer, offset) {
  // first 4 bytes (0-3) are the chunk length
  // A 4-byte unsigned integer giving the number of bytes in the chunk's data field. The length counts only the data field, not itself, the chunk type code, or the CRC. Zero is a valid length
  let lengthView = new DataView(imgBuffer, offset, 4);
  let dataLength = lengthView.getUint32(0);
  // console.log("dataLength as Uint32: ", lengthView, dataLength);

  // next 4 bytes (4-7) are the encoded type
  // A 4-byte chunk type code
  const chunkTypeBytes = new Uint8Array(imgBuffer, offset+4, 4);
  const chunkType = decoder.decode(chunkTypeBytes);
  const dataPartOffsets = [
    offset + 4 + 4,
    offset + 4 + 4 + dataLength,
  ];
  // startIndex, dataLength[4], chunkType[4], [dataLength],
  const chunkObject = {
    startIndex: offset,
    chunkType,
    dataLength,
    dataPartOffsets,
    chunkDataView: new DataView(imgBuffer, dataPartOffsets[0], dataLength),
    nextIndex: dataPartOffsets[1] + 4, // 4 bytes for the CRC
  }
  if (chunkType == "iTXt") {
    chunkObject.decodedData = decoder.decode(new Uint8Array(imgBuffer, dataPartOffsets[0], dataLength));
  }
  console.log("chunkObject:", chunkObject);
  return chunkObject;
}

function insertBytes(byteArray, targetBuffer, offset) {
  // make an array of bytes for the
  var targetArray = new Uint8Array(targetBuffer);
  console.log("byteArray to insert", byteArray.toHex());

  // Check if the offset is within the bounds of the target array
  if (offset < 0 || offset > targetArray.length) {
      throw new Error("Index out of bounds");
  }

  // Create a new ArrayBuffer that is large enough to hold the combined data
  var newBuffer = new ArrayBuffer(targetArray.length + byteArray.length);
  console.log("Creating newBuffer of length:", targetArray.length, targetArray.length + byteArray.length);
  var newArray = new Uint8Array(newBuffer);

  // Copy the original data to the new array up to the offset
  newArray.set(targetArray.subarray(0, offset), 0);
  // console.log("The newArray up to the offset", newArray.subarray(0, offset).toHex());

  // Insert the new data
  newArray.set(byteArray, offset);
  // console.log("The newArray with the byteArray added", newArray.toHex());

  // Copy the remaining part of the original data after the inserted data
  newArray.set(targetArray.subarray(offset), offset + byteArray.length);
  // console.log("The newArray with remainder added", newArray.toHex());

  return newBuffer;
}

export function insertCustomChunk(imgBuffer, textChunk) {
  console.log("insertCustomChunk, imgBuffer.length", imgBuffer.byteLength);
  let offset = 8; // for the signature
  let len = imgBuffer.byteLength;
  let iHDROffsets = [0,0];

  while(!isNaN(offset) && offset < len) {

    let { nextIndex, chunkType } = getChunkAtIndex(imgBuffer, offset);
    // the offset of the next chunk is 4 (length) + 4 (type) + chunkLength + 4 (CRC)
    if (chunkType == "IHDR") {
      // we'll insert our textChunk right after the IHDR
      iHDROffsets[0] = offset;
      iHDROffsets[1] = nextIndex;
    }
    offset = nextIndex;
  }
  console.log("IHDR offsets:", iHDROffsets);
  return insertBytes(textChunk, imgBuffer, iHDROffsets[1]);
  // return imgBuffer;
}


