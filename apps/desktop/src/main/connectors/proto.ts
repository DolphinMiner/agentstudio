// A tiny protobuf (proto3 wire format) codec: enough to talk to Grok Bot's
// Connect RPCs without generated code. Messages are plain objects keyed by
// field name; schemas list (number, name, type) like the protobuf-es "$()"
// field strings they were transcribed from.

export type FieldType = "string" | "bytes" | "bool" | "int64" | "uint32" | "enum" | "message";

export type Field = {
  no: number;
  name: string;
  type: FieldType;
  repeated?: boolean;
  /** For type "message". */
  schema?: Schema;
};

export type Schema = Field[];

export type ProtoValue = string | number | boolean | bigint | Uint8Array | ProtoMessage | ProtoValue[];
export type ProtoMessage = { [name: string]: ProtoValue | undefined };

// ---- writer ------------------------------------------------------------------

class Writer {
  private chunks: number[] = [];

  varint(v: bigint | number) {
    let n = BigInt.asUintN(64, BigInt(v));
    while (n >= 0x80n) {
      this.chunks.push(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    this.chunks.push(Number(n));
  }

  tag(no: number, wire: number) {
    this.varint((no << 3) | wire);
  }

  bytes(b: Uint8Array) {
    this.varint(b.length);
    for (const x of b) this.chunks.push(x);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encode(schema: Schema, msg: ProtoMessage): Uint8Array {
  const w = new Writer();
  for (const f of schema) {
    const v = msg[f.name];
    if (v === undefined || v === null) continue;
    const values = f.repeated && Array.isArray(v) ? v : [v];
    for (const x of values) writeField(w, f, x as ProtoValue);
  }
  return w.finish();
}

function writeField(w: Writer, f: Field, v: ProtoValue) {
  switch (f.type) {
    case "string":
      w.tag(f.no, 2);
      w.bytes(enc.encode(String(v)));
      break;
    case "bytes":
      w.tag(f.no, 2);
      w.bytes(v as Uint8Array);
      break;
    case "bool":
      w.tag(f.no, 0);
      w.varint(v ? 1 : 0);
      break;
    case "int64":
    case "uint32":
    case "enum":
      w.tag(f.no, 0);
      w.varint(typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v))));
      break;
    case "message":
      w.tag(f.no, 2);
      w.bytes(encode(f.schema ?? [], v as ProtoMessage));
      break;
  }
}

// ---- reader ------------------------------------------------------------------

class Reader {
  pos = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get done() {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error("protobuf: truncated varint");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("protobuf: varint too long");
    }
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("protobuf: truncated field");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(wire: number) {
    switch (wire) {
      case 0:
        this.varint();
        break;
      case 1:
        this.take(8);
        break;
      case 2:
        this.take(Number(this.varint()));
        break;
      case 5:
        this.take(4);
        break;
      default:
        throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
  }
}

/** Decodes the fields in schema; unknown fields are skipped. int64 becomes a number when safe. */
export function decode(schema: Schema, buf: Uint8Array): ProtoMessage {
  const byNo = new Map(schema.map((f) => [f.no, f]));
  const out: ProtoMessage = {};
  const r = new Reader(buf);
  while (!r.done) {
    const key = Number(r.varint());
    const no = key >>> 3;
    const wire = key & 7;
    const f = byNo.get(no);
    if (!f) {
      r.skip(wire);
      continue;
    }
    let v: ProtoValue;
    if (wire === 2) {
      const b = r.take(Number(r.varint()));
      if (f.type === "string") v = dec.decode(b);
      else if (f.type === "message") v = decode(f.schema ?? [], b);
      else if (f.type === "bytes") v = b.slice();
      else {
        // Packed repeated scalars.
        const inner = new Reader(b);
        const vals: ProtoValue[] = [];
        while (!inner.done) vals.push(scalar(f, inner.varint()));
        const prev = (out[f.name] as ProtoValue[] | undefined) ?? [];
        out[f.name] = [...prev, ...vals];
        continue;
      }
    } else if (wire === 0) {
      v = scalar(f, r.varint());
    } else {
      r.skip(wire);
      continue;
    }
    if (f.repeated) ((out[f.name] ??= []) as ProtoValue[]).push(v);
    else out[f.name] = v;
  }
  return out;
}

function scalar(f: Field, n: bigint): ProtoValue {
  if (f.type === "bool") return n !== 0n;
  if (f.type === "int64") {
    const s = BigInt.asIntN(64, n);
    return s >= BigInt(Number.MIN_SAFE_INTEGER) && s <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(s) : s;
  }
  return Number(n);
}
