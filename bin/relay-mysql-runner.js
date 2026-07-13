#!/usr/bin/env node
'use strict';

// The webpack runner entry invokes main when the bundle is loaded. Requiring
// it here is therefore the complete executable hand-off; invoking the exported
// main again would make two runner instances compete for the same stdin.
require('../dist/runner.js');
