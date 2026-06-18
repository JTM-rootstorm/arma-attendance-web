#!/usr/bin/env node

const [mode, expression] = process.argv.slice(2);
const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data));
});

const data = JSON.parse(input);

if (mode === "value") {
  let value = data;
  for (const part of expression.replace(/^\./, "").split(".")) {
    if (!part) {
      continue;
    }
    value = value?.[part];
  }
  console.log(value ?? "");
} else if (mode === "assert") {
  const ok = Function("data", `return (${expression});`)(data);
  if (!ok) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
} else {
  console.error("Usage: smoke-json.mjs value|assert <expression>");
  process.exit(2);
}
