delete process.env.ELECTRON_RUN_AS_NODE;
const { spawn } = require("child_process");
const electron = require("electron");
const child = spawn(electron, ["."], { stdio: "inherit", env: process.env });
child.on("close", (code) => process.exit(code ?? 0));
