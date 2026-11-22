import { z } from 'zod';

// Minimal Zod → JSON Schema conversion for structured outputs (doc 12 §5.4).
// Covers the Zod features our AI reply contracts use; anything else becomes an
// unconstrained `{}` (the Zod validation after the call stays authoritative,
// so a looser schema only means the provider enforces less).

type Json = Record<string, unknown>;

export function zodToJsonSchema(schema: z.ZodTypeAny): Json {
  const def = schema._def as { typeName?: string; description?: string };
  const out = convert(schema);
  if (def.description && !out.description) out.description = def.description;
  return out;
}

function convert(schema: z.ZodTypeAny): Json {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return convert(schema._def.innerType);
  if (schema instanceof z.ZodNullable) return { anyOf: [convert(schema._def.innerType), { type: 'null' }] };
  if (schema instanceof z.ZodEffects) return convert(schema._def.schema);
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) {
    const checks = (schema._def.checks ?? []) as { kind: string; value?: number }[];
    const out: Json = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
    for (const c of checks) {
      if (c.kind === 'min') out.minimum = c.value;
      if (c.kind === 'max') out.maximum = c.value;
    }
    return out;
  }
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodLiteral) return { const: schema._def.value };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...schema._def.values] };
  if (schema instanceof z.ZodArray) return { type: 'array', items: convert(schema._def.type) };
  if (schema instanceof z.ZodRecord) return { type: 'object', additionalProperties: convert(schema._def.valueType) };
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    const options = (schema._def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>);
    const list = Array.isArray(options) ? options : [...options.values()];
    return { anyOf: list.map(convert) };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Json = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      if (!value.isOptional()) required.push(key);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
  }
  return {};
}
