#!/usr/bin/env node

process.stderr.write("secret diagnostic output\n".repeat(2_000));
process.exit(31);
