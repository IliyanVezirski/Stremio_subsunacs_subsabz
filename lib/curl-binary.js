const path = require('node:path');
const version = '2.3.1';
const platforms = {
    'linux-x64': { target: 'x86_64-linux-gnu', sha256: '0d8551cc1620be3c40c6f42d0b46c7077e0fe2a1a28a69d659e49e4f412cd0a0', member: 'curl-impersonate' },
    'linux-arm64': { target: 'aarch64-linux-gnu', sha256: '9a8009cc87d950374a85645b771e422e855fc070f3ab099ba7ab944755cd54c3', member: 'curl-impersonate' },
    'win32-x64': { target: 'x86_64-win32', sha256: 'c7c450e5c5114c70a11c03eb8488c29395abebc2411758e8c064734882e1beca', member: './curl-impersonate.exe' }
};
const platform = platforms[`${process.platform}-${process.arch}`];
const directory = path.join(__dirname, '..', 'node_modules', '.cache', 'subsland-curl', version, `${process.platform}-${process.arch}`);
const binary = path.join(directory, process.platform === 'win32' ? 'curl-impersonate.exe' : 'curl-impersonate');
module.exports = { version, platform, directory, binary };
