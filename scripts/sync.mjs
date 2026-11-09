// Lurex24 authoritative sync: reads the contract's own views and writes data/state.json.
// Runs in GitHub Actions on a schedule. The dashboard only reads the JSON.
import { ethers } from "ethers";
import fs from "fs";

const RPC_URLS = ["https://bsc-mainnet.nodereal.io/v1/f07c313cc8b14e4189532dd21eb9c149", "https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.binance.org"];
const CORE = "0xC6e1253b604bdc53172a5ED0fcCc52e8a22367AD";
const DEPLOY = 117243021;
const CHUNK = 5000;
const CONC = 8;
const OS_ABI = ['function overlayState(uint256 userId) view returns ((address wallet,uint256 sponsorId,uint256 binaryParentId,uint256 leftChildId,uint256 rightChildId) core, (uint8 plan,uint256 autoPlan11Progress) planState, (uint256 lifetimeEarned,uint256 totalWithdrawn,uint256 claimable,uint256 capCycleBase,uint64 packageCycleId) incomeState, (uint256 leftCarryPoints,uint256 rightCarryPoints,uint256 leftActivePlanUsers,uint256 rightActivePlanUsers) binaryAccounting, bool binaryMaterialized, uint256 binaryCarryCycleStart)'];
const USER_CREATED = ['event UserCreated(uint256 indexed userId, address indexed wallet, uint256 indexed sponsorId, uint256 binaryParentId, uint8 side, uint8 plan)'];

let provider = null;
async function getProvider() {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch (e) {}
  }
  throw new Error("no RPC endpoint reachable");
}

const withRetry = async (fn, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * 2 ** i));
    }
  }
};

const ZERO = "0x0000000000000000000000000000000000000000";
const fu18 = x => Number(ethers.formatUnits(x, 18));

async function main() {
  provider = await getProvider();
  const core = new ethers.Contract(CORE, OS_ABI, provider);
  const latest = await withRetry(() => provider.getBlockNumber());
  const iface = new ethers.Interface(USER_CREATED);
  const topic = iface.getEvent("UserCreated").topicHash;

  // 1) discover ids from UserCreated events
  const ids = new Set();
  for (let from = DEPLOY; from <= latest; from += CHUNK) {
    const to = Math.min(latest, from + CHUNK - 1);
    const logs = await withRetry(() => provider.getLogs({ address: CORE, fromBlock: from, toBlock: to, topics: [topic] }));
    for (const l of logs) ids.add(Number(iface.parseLog(l).args.userId));
  }
  // 2) probe past the highest id to catch anything the logs missed
  let max = Math.max(0, ...ids), miss = 0, n = max + 1;
  while (miss < 400) {
    const batch = Array.from({ length: CONC }, (_, i) => n + i);
    n += CONC;
    const res = await Promise.all(batch.map(id => core.overlayState(id).then(r => r, () => null)));
    res.forEach((r, i) => {
      if (r && r.core.wallet !== ZERO) { ids.add(batch[i]); miss = 0; } else miss++;
    });
  }

  // 3) read the contract's own state for every id
  const all = [...ids].sort((a, b) => a - b);
  const users = {};
  for (let i = 0; i < all.length; i += CONC) {
    const batch = all.slice(i, i + CONC);
    const res = await Promise.all(batch.map(id => withRetry(() => core.overlayState(id))));
    batch.forEach((id, k) => {
      const r = res[k];
      users[id] = {
        w: r.core.wallet.toLowerCase(), sp: Number(r.core.sponsorId), par: Number(r.core.binaryParentId),
        p: Number(r.planState.plan), created: true,
        ov: {
          wallet: r.core.wallet, plan: Number(r.planState.plan),
          lifetime: fu18(r.incomeState.lifetimeEarned), claimable: fu18(r.incomeState.claimable),
          withdrawn: fu18(r.incomeState.totalWithdrawn),
          lAct: Number(r.binaryAccounting.leftActivePlanUsers), rAct: Number(r.binaryAccounting.rightActivePlanUsers),
          sp: Number(r.core.sponsorId), par: Number(r.core.binaryParentId),
          lc: Number(r.core.leftChildId), rc: Number(r.core.rightChildId),
        },
      };
    });
    if (i % 400 === 0) console.log(`read ${i}/${all.length}`);
  }
  // side of each user comes from its parent's child pointers
  for (const id of all) {
    const u = users[id], par = users[u.par];
    if (!par) continue;
    const side = par.ov.lc === id ? "L" : par.ov.rc === id ? "R" : "";
    u.side = side; u.ov.side = side;
  }

  const out = { v: 4, last: latest, generated: new Date().toISOString(), count: all.length, users };
  fs.writeFileSync("state.json", JSON.stringify(out));
  console.log(`done: ${all.length} users, block ${latest}`);
}

main().catch(e => { console.error(e); process.exit(1); });
