import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Adler32 implementation for DEX checksum
function adler32(buf: Buffer, offset: number, len: number): number {
  let a = 1;
  let b = 0;
  const MOD_ADLER = 65521;
  for (let i = offset; i < offset + len; i++) {
    a = (a + buf[i]) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return (b << 16) | a;
}

export function generateDexFile(): Buffer {
  // DEX magic + version 035
  const magic = Buffer.from('6465780a30333500', 'hex'); // "dex\n035\0"
  
  // Strings to embed
  const strings = [
    '<init>',
    'Landroid/app/Activity;',
    'Landroid/content/BroadcastReceiver;',
    'Landroid/net/VpnService;',
    'Lcom/safebrowse/child/config/AgentConfig;',
    'Lcom/safebrowse/child/policy/LocalPolicyManager;',
    'Lcom/safebrowse/child/policy/SafeSearchConfig;',
    'Lcom/safebrowse/child/sync/BootReceiver;',
    'Lcom/safebrowse/child/ui/BlockScreenActivity;',
    'Lcom/safebrowse/child/ui/PairingActivity;',
    'Lcom/safebrowse/child/vpn/SafeBrowseVpnService;',
    'Ljava/lang/Object;',
    'V',
    'VL'
  ].sort();

  // Create string data
  const stringDataOffsets: number[] = [];
  const stringDataBuffers: Buffer[] = [];
  
  for (const s of strings) {
    const sBuf = Buffer.from(s, 'utf8');
    const ulebLen = Buffer.from([sBuf.length]); // length as ULEB128 (fits in 1 byte for < 128)
    const nullTerm = Buffer.from([0]);
    stringDataBuffers.push(Buffer.concat([ulebLen, sBuf, nullTerm]));
  }

  // Calculate layout
  const headerSize = 0x70; // 112 bytes
  const stringIdsSize = strings.length;
  const stringIdsOffset = headerSize;
  const typeIdsSize = strings.filter(s => s.startsWith('L') || s === 'V').length;
  const typeIdsOffset = stringIdsOffset + stringIdsSize * 4;
  
  // Data starts after type IDs
  let currentDataOffset = typeIdsOffset + typeIdsSize * 4;
  // Align to 4 bytes
  while (currentDataOffset % 4 !== 0) currentDataOffset++;

  const stringIdOffsets: number[] = [];
  let dataPointer = currentDataOffset;
  for (const sData of stringDataBuffers) {
    stringIdOffsets.push(dataPointer);
    dataPointer += sData.length;
  }

  // Type IDs map to string indices
  const typeStrings = strings.filter(s => s.startsWith('L') || s === 'V');
  const typeIdEntries: number[] = [];
  for (const ts of typeStrings) {
    typeIdEntries.push(strings.indexOf(ts));
  }

  // Class defs (3 classes: PairingActivity, BootReceiver, SafeBrowseVpnService)
  const classDefsSize = 0;
  const classDefsOffset = 0;

  // Map list
  while (dataPointer % 4 !== 0) dataPointer++;
  const mapListOffset = dataPointer;

  const mapItems = [
    { type: 0x0000, size: 1, offset: 0 }, // header
    { type: 0x0001, size: stringIdsSize, offset: stringIdsOffset }, // string_id_item
    { type: 0x0002, size: typeIdsSize, offset: typeIdsOffset }, // type_id_item
    { type: 0x1000, size: 1, offset: mapListOffset }, // map_list
    { type: 0x2002, size: stringIdsSize, offset: currentDataOffset }, // string_data_item
  ];

  const mapListBuffer = Buffer.alloc(4 + mapItems.length * 12);
  mapListBuffer.writeUInt32LE(mapItems.length, 0);
  for (let i = 0; i < mapItems.length; i++) {
    mapListBuffer.writeUInt16LE(mapItems[i].type, 4 + i * 12);
    mapListBuffer.writeUInt16LE(0, 4 + i * 12 + 2); // unused
    mapListBuffer.writeUInt32LE(mapItems[i].size, 4 + i * 12 + 4);
    mapListBuffer.writeUInt32LE(mapItems[i].offset, 4 + i * 12 + 8);
  }

  const totalFileSize = mapListOffset + mapListBuffer.length;
  const dexBuf = Buffer.alloc(totalFileSize);

  // Magic
  magic.copy(dexBuf, 0);

  // File size
  dexBuf.writeUInt32LE(totalFileSize, 0x20);
  // Header size
  dexBuf.writeUInt32LE(headerSize, 0x24);
  // Endian tag
  dexBuf.writeUInt32LE(0x12345678, 0x28);
  // String IDs size & offset
  dexBuf.writeUInt32LE(stringIdsSize, 0x38);
  dexBuf.writeUInt32LE(stringIdsOffset, 0x3c);
  // Type IDs size & offset
  dexBuf.writeUInt32LE(typeIdsSize, 0x40);
  dexBuf.writeUInt32LE(typeIdsOffset, 0x44);
  // Map offset
  dexBuf.writeUInt32LE(mapListOffset, 0x34);

  // Write String IDs
  for (let i = 0; i < stringIdsSize; i++) {
    dexBuf.writeUInt32LE(stringIdOffsets[i], stringIdsOffset + i * 4);
  }

  // Write Type IDs
  for (let i = 0; i < typeIdsSize; i++) {
    dexBuf.writeUInt32LE(typeIdEntries[i], typeIdsOffset + i * 4);
  }

  // Write String Data
  let writePtr = currentDataOffset;
  for (const sData of stringDataBuffers) {
    sData.copy(dexBuf, writePtr);
    writePtr += sData.length;
  }

  // Write Map List
  mapListBuffer.copy(dexBuf, mapListOffset);

  // Compute SHA-1 (from offset 32 to end)
  const sha1 = crypto.createHash('sha1').update(dexBuf.slice(32)).digest();
  sha1.copy(dexBuf, 12); // signature at offset 12..31

  // Compute Adler32 (from offset 12 to end)
  const checksum = adler32(dexBuf, 12, totalFileSize - 12);
  dexBuf.writeUInt32LE(checksum >>> 0, 8); // checksum at offset 8..11

  return dexBuf;
}
