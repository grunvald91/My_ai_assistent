// inflate.js — распаковка DEFLATE (RFC 1951) на чистом JavaScript.
// В изоляте Telegram нет ни zlib, ни DecompressionStream, а docx/xlsx/pptx — это zip с deflate внутри.
// Порт алгоритма tiny-inflate (MIT, Joergen Ibsen / Devon Govett): таблицы Хаффмана без рекурсии.

function Tree() {
  this.table = new Uint16Array(16);
  this.trans = new Uint16Array(288);
}

function Data(source, dest) {
  this.source = source;
  this.sourceIndex = 0;
  this.tag = 0;
  this.bitcount = 0;
  this.dest = dest;
  this.destLen = 0;
  this.ltree = new Tree();
  this.dtree = new Tree();
}

const sltree = new Tree();
const sdtree = new Tree();
const lengthBits = new Uint8Array(30);
const lengthBase = new Uint16Array(30);
const distBits = new Uint8Array(30);
const distBase = new Uint16Array(30);
const clcidx = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
const codeTree = new Tree();
const offs = new Uint16Array(16);

function buildBitsBase(bits, base, delta, first) {
  let i;
  let sum;
  for (i = 0; i < delta; ++i) bits[i] = 0;
  for (i = 0; i < 30 - delta; ++i) bits[i + delta] = (i / delta) | 0;
  for (sum = first, i = 0; i < 30; ++i) {
    base[i] = sum;
    sum += 1 << bits[i];
  }
}

function buildFixedTrees(lt, dt) {
  let i;
  for (i = 0; i < 7; ++i) lt.table[i] = 0;
  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;
  for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
  for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
  for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;
  for (i = 0; i < 5; ++i) dt.table[i] = 0;
  dt.table[5] = 32;
  for (i = 0; i < 32; ++i) dt.trans[i] = i;
}

function buildTree(t, lengths, off, num) {
  let i;
  let sum;
  for (i = 0; i < 16; ++i) t.table[i] = 0;
  for (i = 0; i < num; ++i) t.table[lengths[off + i]]++;
  t.table[0] = 0;
  for (sum = 0, i = 0; i < 16; ++i) {
    offs[i] = sum;
    sum += t.table[i];
  }
  for (i = 0; i < num; ++i) if (lengths[off + i]) t.trans[offs[lengths[off + i]]++] = i;
}

function getBit(d) {
  if (!d.bitcount--) {
    d.tag = d.source[d.sourceIndex++];
    d.bitcount = 7;
  }
  const bit = d.tag & 1;
  d.tag >>>= 1;
  return bit;
}

function readBits(d, num, base) {
  if (!num) return base;
  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }
  const val = d.tag & (0xffff >>> (16 - num));
  d.tag >>>= num;
  d.bitcount -= num;
  return val + base;
}

function decodeSymbol(d, t) {
  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }
  let sum = 0;
  let cur = 0;
  let len = 0;
  let tag = d.tag;
  do {
    cur = 2 * cur + (tag & 1);
    tag >>>= 1;
    ++len;
    sum += t.table[len];
    cur -= t.table[len];
  } while (cur >= 0 && len < 16);
  if (cur >= 0) throw new Error('inflate: повреждённые данные');
  d.tag = tag;
  d.bitcount -= len;
  return t.trans[sum + cur];
}

function decodeDynamicTree(d, lt, dt) {
  const lengths = new Uint8Array(288 + 32);
  const hlit = readBits(d, 5, 257);
  const hdist = readBits(d, 5, 1);
  const hclen = readBits(d, 4, 4);
  for (let i = 0; i < 19; ++i) lengths[i] = 0;
  for (let i = 0; i < hclen; ++i) lengths[clcidx[i]] = readBits(d, 3, 0);
  buildTree(codeTree, lengths, 0, 19);
  let num = 0;
  while (num < hlit + hdist) {
    const sym = decodeSymbol(d, codeTree);
    let prev;
    let length;
    switch (sym) {
      case 16:
        prev = lengths[num - 1];
        for (length = readBits(d, 2, 3); length; --length) lengths[num++] = prev;
        break;
      case 17:
        for (length = readBits(d, 3, 3); length; --length) lengths[num++] = 0;
        break;
      case 18:
        for (length = readBits(d, 7, 11); length; --length) lengths[num++] = 0;
        break;
      default:
        lengths[num++] = sym;
    }
  }
  buildTree(lt, lengths, 0, hlit);
  buildTree(dt, lengths, hlit, hdist);
}

function inflateBlockData(d, lt, dt) {
  for (;;) {
    let sym = decodeSymbol(d, lt);
    if (sym === 256) return;
    if (sym < 256) {
      d.dest[d.destLen++] = sym;
    } else {
      sym -= 257;
      const length = readBits(d, lengthBits[sym], lengthBase[sym]);
      const dist = decodeSymbol(d, dt);
      const from = d.destLen - readBits(d, distBits[dist], distBase[dist]);
      if (from < 0) throw new Error('inflate: повреждённые данные');
      for (let i = from; i < from + length; ++i) d.dest[d.destLen++] = d.dest[i];
    }
  }
}

function inflateUncompressedBlock(d) {
  while (d.bitcount > 8) {
    d.sourceIndex--;
    d.bitcount -= 8;
  }
  let length = d.source[d.sourceIndex + 1];
  length = 256 * length + d.source[d.sourceIndex];
  d.sourceIndex += 4;
  for (let i = length; i; --i) d.dest[d.destLen++] = d.source[d.sourceIndex++];
  d.bitcount = 0;
}

buildFixedTrees(sltree, sdtree);
buildBitsBase(lengthBits, lengthBase, 4, 3);
buildBitsBase(distBits, distBase, 2, 1);
lengthBits[28] = 0;
lengthBase[28] = 258;

/** Распаковывает «сырой» deflate. size — ожидаемый размер результата (в zip он известен). */
export function inflateRaw(source, size) {
  const d = new Data(source, new Uint8Array(size));
  let bfinal;
  do {
    bfinal = getBit(d);
    const btype = readBits(d, 2, 0);
    if (btype === 0) inflateUncompressedBlock(d);
    else if (btype === 1) inflateBlockData(d, sltree, sdtree);
    else if (btype === 2) {
      decodeDynamicTree(d, d.ltree, d.dtree);
      inflateBlockData(d, d.ltree, d.dtree);
    } else throw new Error('inflate: неизвестный тип блока');
    if (d.sourceIndex > source.length + 8) throw new Error('inflate: данные оборваны');
  } while (!bfinal);
  return d.destLen === size ? d.dest : d.dest.subarray(0, d.destLen);
}
