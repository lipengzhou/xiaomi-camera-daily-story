import assert from "node:assert/strict";
import { test } from "node:test";

import { SpawnCommandRunner } from "../src/sync/commands.js";

test("spawn command runner streams a Buffer to subprocess stdin", async () => {
  const runner = new SpawnCommandRunner();
  const input = Buffer.from("#EXTM3U\nhttps://media.example/segment.ts?token=secret\n");
  const result = await runner.run(
    process.execPath,
    [
      "-e",
      "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(String(Buffer.byteLength(data))))",
    ],
    { stdin: input },
  );
  assert.equal(result.stdout, String(input.length));
});

test("spawn command runner redacts signed URLs and tokens from failures", async () => {
  const runner = new SpawnCommandRunner();
  await assert.rejects(
    () =>
      runner.run(process.execPath, [
        "-e",
        "process.stderr.write('https://media.example/segment.ts?token=secret&signature=private serviceToken=value');process.exit(3)",
      ]),
    (error: Error) => {
      assert.doesNotMatch(error.message, /secret|private|serviceToken=value/);
      assert.match(error.message, /<redacted>/);
      return true;
    },
  );
});
