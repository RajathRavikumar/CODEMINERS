class Block {
  constructor(index, timestamp, data, previousHash = "") {
    this.index = index;
    this.timestamp = timestamp;
    this.data = data;
    this.previousHash = previousHash;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return CryptoJS.SHA256(this.index + this.previousHash + JSON.stringify(this.data) + this.timestamp).toString();
  }
}

class Blockchain {
  constructor() {
    this.chain = [this.createGenesisBlock()];
  }

  createGenesisBlock() {
    return new Block(0, "2025-04-15T00:00:00Z", "Genesis Block", "0");
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  addBlock(newBlock) {
    newBlock.previousHash = this.getLatestBlock().hash;
    newBlock.hash = newBlock.calculateHash();
    this.chain.push(newBlock);
    console.log(`Block added, chain length: ${this.chain.length} New block:`, newBlock);
  }

  isChainValid() {
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];

      if (currentBlock.hash !== currentBlock.calculateHash()) {
        console.log("Invalid hash for block", currentBlock);
        return false;
      }

      if (currentBlock.previousHash !== previousBlock.hash) {
        console.log("Invalid previous hash link", currentBlock, previousBlock);
        return false;
      }
    }
    console.log("Blockchain validated:", this.chain.length, "blocks");
    return true;
  }
}