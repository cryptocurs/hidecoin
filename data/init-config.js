'use strict'

/* 1 XHD = 10^8 = 100 000 000 micoins */

module.exports = {
  /* IPv4 support
  *  Set this setting to 'true' if your device supports IPv4 addresses
  */
  allowIpv4: true,
  
  /* IPv6 support
  *  Set this setting to 'true' if your device supports IPv6 addresses
  */
  allowIpv6: false,
  
  /* Server port
  *  Port which uses for connecting other members to your device. Default: 7438
  */
  myServerPort: 7438,
  
  /* Miner mode
  *  If set to 'true' then device will create new coins (recommended)
  */
  minerMode: false,
  
  /* Miner address
  *  Addresses for new coins, format:
  *  [
  *   'ADDRESS1',
  *   'ADDRESS2',
  *   ...
  *   'ADDRESSN'
  *  ],
  *  If you want to use only one address, use:
  *  minerAddresses: ['ADDRESS'],
  */
  minerAddresses: ['--YOUR-HIDECOIN-ADDRESS--'],
  
  /* Wallet port
  *  Port to load wallet in browser: localhost:7439
  */
  walletPort: 7439,
  
  /* Wallet host
  *  Host to load wallet in browser. Default: 'localhost'
  */
  walletHost: 'localhost',
  
  /* Single-threaded
  *  If set to 'true' then application will be single-threaded (as 0.3.x). Used for devices with Windows or
  *  with small amount of RAM
  */
  singleThreaded: true
}