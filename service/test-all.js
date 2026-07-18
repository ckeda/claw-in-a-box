// SPDX-License-Identifier: Apache-2.0
"use strict";

const { spawnSync } = require("node:child_process");

for (const file of ["test-v2.js", "test-v081.js"]) {
  const result = spawnSync(process.execPath, [file], { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
