/**
 * Emits a minimal valid ONNX model: one Identity node, float32, shape [1].
 *
 * Exists so the ORT runtime setup can be exercised without the network. The
 * real models are hundreds of megabytes from the Hugging Face CDN, which CI and
 * sandboxed environments frequently cannot reach — but "does onnxruntime-web
 * initialise from our wasmPaths and run a graph" is answerable with a few
 * hundred bytes, and that is where the failures have actually been.
 *
 * ONNX is protobuf; this hand-rolls just enough of the wire format to avoid a
 * dependency on the onnx tooling.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------- protobuf --- */

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

/** field number + wire type (0 = varint, 2 = length-delimited). */
const tag = (field, wire) => varint((field << 3) | wire);

const vField = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const bField = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const sField = (field, str) => bField(field, Buffer.from(str, 'utf8'));

/* ----------------------------------------------------------------- onnx --- */

// TensorShapeProto.Dimension { dim_value = 1 }
const dim = vField(1, 1);
// TensorShapeProto { dim }
const shape = bField(1, dim);
// TypeProto.Tensor { elem_type = 1 (FLOAT), shape }
const tensorType = Buffer.concat([vField(1, 1), bField(2, shape)]);
// TypeProto { tensor_type }
const typeProto = bField(1, tensorType);

// ValueInfoProto { name, type }
const valueInfo = (name) => Buffer.concat([sField(1, name), bField(2, typeProto)]);

// NodeProto { input, output, name, op_type }
const node = Buffer.concat([
  sField(1, 'x'),
  sField(2, 'y'),
  sField(3, 'identity'),
  sField(4, 'Identity'),
]);

// GraphProto { node, name, input (11), output (12) }
const graph = Buffer.concat([
  bField(1, node),
  sField(2, 'tiny'),
  bField(11, valueInfo('x')),
  bField(12, valueInfo('y')),
]);

// OperatorSetIdProto { version = 13 }; empty domain is the default ONNX domain.
const opset = vField(2, 13);

// ModelProto { ir_version, graph (7), opset_import (8) }
const model = Buffer.concat([vField(1, 8), bField(7, graph), bField(8, opset)]);

const dest = join(root, 'public', 'verify');
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, 'tiny.onnx'), model);
console.log(`onnx: public/verify/tiny.onnx (${model.length} bytes)`);
