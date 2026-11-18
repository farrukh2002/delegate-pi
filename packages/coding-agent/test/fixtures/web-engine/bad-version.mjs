#!/usr/bin/env node
import { keepAlive, ready } from "./harness.mjs";

ready("0.1.0-test", 2);
keepAlive();
