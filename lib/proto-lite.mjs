/**
 * @fileoverview Zero-dependency lightweight Protobuf wire-format decoder
 * specifically tailored for Antigravity's `gen_metadata` SQLite blobs.
 * Produces objects matching the JSON schema of `GetCascadeTrajectoryGeneratorMetadata`.
 */

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Reads a base-128 varint at offset, returning [BigIntValue, nextOffset].
 * @param {Uint8Array} buf
 * @param {number} pos
 * @returns {[bigint, number]}
 */
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  const len = buf.length;
  while (pos < len) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [result, pos];
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error('Malformed varint');
    }
  }
  throw new Error('Unexpected EOF reading varint');
}

/**
 * Iterates over top-level protobuf fields in a buffer.
 * @param {Uint8Array} buf
 * @param {(fieldNo: number, wireType: number, value: bigint | Uint8Array) => void} visitor
 */
export function scanFields(buf, visitor) {
  let pos = 0;
  const len = buf.length;
  while (pos < len) {
    let tag;
    try {
      [tag, pos] = readVarint(buf, pos);
    } catch {
      break;
    }
    const fieldNo = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNo <= 0) break;

    if (wireType === 0) {
      // Varint
      const [val, next] = readVarint(buf, pos);
      pos = next;
      visitor(fieldNo, wireType, val);
    } else if (wireType === 1) {
      // 64-bit fixed
      if (pos + 8 > len) break;
      visitor(fieldNo, wireType, buf.subarray(pos, pos + 8));
      pos += 8;
    } else if (wireType === 2) {
      // Length-delimited
      const [byteLenBig, next] = readVarint(buf, pos);
      const byteLen = Number(byteLenBig);
      pos = next;
      if (byteLen < 0 || pos + byteLen > len) break;
      visitor(fieldNo, wireType, buf.subarray(pos, pos + byteLen));
      pos += byteLen;
    } else if (wireType === 5) {
      // 32-bit fixed
      if (pos + 4 > len) break;
      visitor(fieldNo, wireType, buf.subarray(pos, pos + 4));
      pos += 4;
    } else {
      // Unsupported wireType (start/end group), stop scanning safely
      break;
    }
  }
}

function decodeString(bytes) {
  return UTF8_DECODER.decode(bytes);
}

function decodeDuration(bytes) {
  let seconds = 0n;
  let nanos = 0n;
  scanFields(bytes, (f, wt, v) => {
    if (wt === 0 && f === 1) seconds = BigInt.asIntN(64, v);
    if (wt === 0 && f === 2) nanos = BigInt.asIntN(32, v);
  });
  const totalSec = Number(seconds) + Number(nanos) / 1e9;
  return `${totalSec.toFixed(6)}s`;
}

function decodeMapEntry(bytes) {
  let key = '';
  let val = '';
  scanFields(bytes, (f, wt, v) => {
    if (wt === 2 && f === 1) key = decodeString(v);
    if (wt === 2 && f === 2) val = decodeString(v);
  });
  return [key, val];
}

function decodeUsage(bytes) {
  const usage = {};
  scanFields(bytes, (f, wt, v) => {
    if (wt === 0) {
      const numStr = String(BigInt.asUintN(64, v));
      if (f === 1) usage.modelEnumId = Number(v);
      else if (f === 2) usage.inputTokens = numStr;
      else if (f === 3) usage.outputTokens = numStr;
      else if (f === 4) usage.cacheWriteTokens = numStr;
      else if (f === 5) usage.cacheReadTokens = numStr;
      else if (f === 6) {
        const p = Number(v);
        usage.apiProvider =
          p === 24
            ? 'API_PROVIDER_GOOGLE_GEMINI'
            : p === 14 || p === 15
              ? 'API_PROVIDER_ANTHROPIC_VERTEX'
              : `API_PROVIDER_${p}`;
      } else if (f === 9) usage.thinkingOutputTokens = numStr;
      else if (f === 10) usage.responseOutputTokens = numStr;
    } else if (wt === 2) {
      if (f === 7) usage.messageId = decodeString(v);
      else if (f === 11) usage.responseId = decodeString(v);
    }
  });
  return usage;
}

function decodeTokenBreakdownGroup(bytes) {
  const group = { name: '', numTokens: 0, children: [] };
  scanFields(bytes, (f, wt, v) => {
    if (wt === 2 && f === 1) group.name = decodeString(v);
    else if (wt === 0 && f === 4) group.numTokens = Number(BigInt.asIntN(64, v));
    else if (wt === 2 && f === 5) {
      let childName = '';
      let childTokens = 0;
      scanFields(v, (cf, cwt, cv) => {
        if (cwt === 2 && cf === 1) childName = decodeString(cv);
        else if (cwt === 0 && cf === 4) childTokens = Number(BigInt.asIntN(64, cv));
      });
      if (childName || childTokens) {
        group.children.push({ name: childName, numTokens: childTokens });
      }
    }
  });
  return group;
}

function decodeContextWindowMetadata(bytes) {
  const ctx = {};
  scanFields(bytes, (f, wt, v) => {
    if (wt === 0 && f === 1) {
      ctx.estimatedTokensUsed = Number(BigInt.asIntN(64, v));
    } else if (wt === 2 && f === 3) {
      const groups = [];
      let totalTokens = 0;
      scanFields(v, (bf, bwt, bv) => {
        if (bwt === 2 && bf === 1) groups.push(decodeTokenBreakdownGroup(bv));
        else if (bwt === 0 && bf === 2) totalTokens = Number(BigInt.asIntN(64, bv));
      });
      ctx.tokenBreakdown = { groups, totalTokens };
    } else if (wt === 0 && f === 4) {
      ctx.maxContextTokens = Number(BigInt.asIntN(64, v));
    }
  });
  return ctx;
}

function decodeChatModel(bytes) {
  const chatModel = {
    customMetadata: {},
    retryInfos: [],
  };
  scanFields(bytes, (f, wt, v) => {
    if (wt === 0 && f === 3) {
      chatModel.modelEnumId = Number(v);
    } else if (wt === 2 && f === 4) {
      chatModel.usage = decodeUsage(v);
    } else if (wt === 2 && f === 9) {
      const chatStartMetadata = {};
      scanFields(v, (sf, swt, sv) => {
        if (swt === 0 && sf === 2) {
          chatStartMetadata.checkpointIndex = Number(BigInt.asIntN(64, sv));
        } else if (swt === 2 && sf === 10) {
          chatStartMetadata.contextWindowMetadata = decodeContextWindowMetadata(sv);
        }
      });
      chatModel.chatStartMetadata = chatStartMetadata;
    } else if (wt === 2 && f === 11) {
      chatModel.timeToFirstToken = decodeDuration(v);
    } else if (wt === 2 && f === 12) {
      chatModel.streamingDuration = decodeDuration(v);
    } else if (wt === 2 && f === 17) {
      const retry = {};
      scanFields(v, (rf, rwt, rv) => {
        if (rwt === 2 && rf === 2) retry.usage = decodeUsage(rv);
        else if (rwt === 2 && rf === 3) retry.error = decodeString(rv);
        else if (rwt === 2 && rf === 4) retry.traceId = decodeString(rv);
      });
      chatModel.retryInfos.push(retry);
    } else if (wt === 2 && f === 19) {
      chatModel.responseModel = decodeString(v);
    } else if (wt === 2 && f === 20) {
      const [k, val] = decodeMapEntry(v);
      if (k) chatModel.customMetadata[k] = val;
    } else if (wt === 2 && f === 21) {
      chatModel.modelDisplayName = decodeString(v);
    }
  });

  if (chatModel.customMetadata.model_enum) {
    chatModel.model = chatModel.customMetadata.model_enum;
    if (chatModel.usage && !chatModel.usage.model) {
      chatModel.usage.model = chatModel.customMetadata.model_enum;
    }
  } else if (chatModel.modelEnumId) {
    chatModel.model = `MODEL_ENUM_${chatModel.modelEnumId}`;
  }
  return chatModel;
}

/**
 * Decodes a single `gen_metadata.data` protobuf blob into a GeneratorMetadata object.
 * @param {Uint8Array | Buffer} blob
 * @returns {object}
 */
export function decodeGeneratorMetadataBlob(blob) {
  const buf = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const entry = {
    stepIndices: [],
  };

  scanFields(buf, (f, wt, v) => {
    if (wt === 2 && f === 1) {
      entry.chatModel = decodeChatModel(v);
    } else if (wt === 0 && f === 2) {
      entry.stepIndices.push(Number(v));
    } else if (wt === 2 && f === 2) {
      // Packed repeated varint stepIndices
      let pos = 0;
      while (pos < v.length) {
        try {
          const [stepIdx, next] = readVarint(v, pos);
          entry.stepIndices.push(Number(stepIdx));
          pos = next;
        } catch {
          break;
        }
      }
    } else if (wt === 2 && f === 3) {
      // plannerConfig
      const plannerConfig = {};
      scanFields(v, (pf, pwt, pv) => {
        if (pwt === 0 && pf === 6) {
          plannerConfig.maxOutputTokens = Number(pv);
        }
      });
      entry.plannerConfig = plannerConfig;
    } else if (wt === 2 && f === 4) {
      entry.executionId = decodeString(v);
    }
  });

  return entry;
}
