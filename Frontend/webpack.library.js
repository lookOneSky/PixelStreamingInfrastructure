// Copyright Epic Games, Inc. All Rights Reserved.

const path = require('path');

// Keep standalone browser bundles alongside the workspace package's CJS and ES modules.
module.exports = ({ entry }) => {
    const name = `lib-${entry}`;
    const config = {
        mode: 'production',
        entry: `./dist/esm/${entry}.js`
    };
    const output = { path: path.resolve('dist'), globalObject: 'this' };
    return [
        {
            ...config,
            output: { ...output, filename: `${name}.js`, library: { type: 'umd', name } }
        },
        {
            ...config,
            experiments: { outputModule: true },
            output: { ...output, filename: `${name}.esm.js`, library: { type: 'module' } }
        }
    ];
};
