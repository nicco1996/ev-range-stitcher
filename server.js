function decodeFPL(str) {
  let idx = 0;

  function readVarUInt() {
    let result = 0, shift = 0, b;
    do {
      if (idx >= str.length) throw new Error('FPL truncated');
      b = str.charCodeAt(idx++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result >>> 0;
  }

  function readVarInt() {
    const u = readVarUInt();
    const sign = (u & 1) ? -1 : 1;
    return sign * (u >> 1);
  }

  // header
  const version = str.charCodeAt(idx++) - 63;
  // REMOVE THIS CHECK - accept any version
  // if (version !== 1) throw new Error('Unsupported FPL version');
  
  const precision = readVarUInt();
  const thirdDim = readVarUInt();
  const thirdPrec = readVarUInt();

  const factor = Math.pow(10, precision);
  const thirdFactor = Math.pow(10, thirdPrec);

  let lat = 0, lng = 0, z = 0;
  const out = [];

  while (idx < str.length) {
    lat += readVarInt();
    lng += readVarInt();
    if (thirdDim !== 0) z += readVarInt();

    out.push([lat / factor, lng / factor]);
  }
  return out;
}
