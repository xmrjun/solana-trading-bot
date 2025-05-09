import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import * as fs from 'fs';
import * as path from 'path';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

// 定义日志消息类型
interface LogMessage {
  mint?: string;
  signature?: string;
  error?: any;
  [key: string]: any;
}

// 定义交易记录接口
interface TradeRecord {
  timestamp: string;
  token_address: string;
  token_symbol: string;
  buy_price_usdt: number;
  sell_price_usdt: number;
  profit_percentage: number;
  volume_usdt: number;
  liquidity_usdt: number;
  volatility: number;
  gas_fee_usdt: number;
  slippage: number;
  transaction_hash?: string;
  sol_usdt_price: number;
}

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
}

export class Bot {
  private readonly poolFilters: PoolFilters;
  private readonly snipeListCache?: SnipeListCache;
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  private priceHistory: { [key: string]: number[] } = {};
  private tradeHistory: { [key: string]: TradeRecord[] } = {};
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;
  private readonly priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly poolInfoCache: Map<string, { info: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 60 * 1000; // 1分钟缓存

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }

    // 确保数据目录存在
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }
    return true;
  }

  private async getSolUsdtPrice(): Promise<number> {
    try {
      // 使用完整的 USDT/SOL 池子配置
      const usdtSolPoolKeys: LiquidityPoolKeysV4 = {
        id: new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),
        baseMint: new PublicKey('So11111111111111111111111111111111111111112'),
        quoteMint: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
        lpMint: new PublicKey('8HoQnePLqPj4M7PUDzfw8e3Ymdwgc7NLGnaTUapubyvu'),
        baseDecimals: 9,
        quoteDecimals: 6,
        lpDecimals: 9,
        version: 4,
        programId: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
        authority: new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'),
        openOrders: new PublicKey('HRk9CMrpq7Jn9sh7mzxE8CChHG8dneX9p475QKz4Fsfc'),
        targetOrders: new PublicKey('CZza3Ej4Mc58MnxWA385itCC9jCo3L1D7zc3LKy1bZMR'),
        baseVault: new PublicKey('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz'),
        quoteVault: new PublicKey('HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz'),
        withdrawQueue: new PublicKey('G7xeGGGyvX3DmF1VK5C1qQvxVxqQJfYxVxqQJfYxVxqQ'),
        lpVault: new PublicKey('7GjuoekUxM9DJmzJKDbM9YZUua65JShfFwsdutVSAAYQ'),
        marketVersion: 3,
        marketProgramId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
        marketId: new PublicKey('9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT'),
        marketAuthority: new PublicKey('14ivtgssEBoBjuZJtSAPKYgpUK7hYFhqVqVqVqVqVqVq'),
        marketBaseVault: new PublicKey('20G81Fg5aym2Cx5Ua9XmW7iU8P3UytiLfLfLfLfLfLf'),
        marketQuoteVault: new PublicKey('6U6U59zmFWrPSzm9sLX7kVkaK78Kz7XJYkYkYkYkYkYk'),
        marketBids: new PublicKey('14ivtgssEBoBjuZJtSAPKYgpUK7hYFhqVqVqVqVqVqVq'),
        marketAsks: new PublicKey('14ivtgssEBoBjuZJtSAPKYgpUK7hYFhqVqVqVqVqVqVq'),
        marketEventQueue: new PublicKey('14ivtgssEBoBjuZJtSAPKYgpUK7hYFhqVqVqVqVqVqVq'),
        lookupTableAccount: new PublicKey('9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT')
      };

      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys: usdtSolPoolKeys
      });
      return poolInfo.quoteReserve.toNumber() / poolInfo.baseReserve.toNumber();
    } catch (error) {
      logger.error({ error }, '获取 SOL/USDT 价格失败，使用回退价格');
      return 150; // 回退价格
    }
  }

  private async getTokenInfo(mint: PublicKey): Promise<{ symbol: string; decimals: number } | null> {
    try {
      // 使用 gmgn.ai API 获取代币信息
      const response = await fetch(`https://gmgn.ai/sol/address/${mint.toString()}`);
      const data = await response.json();
      
      if (data && data.symbol) {
        return {
          symbol: data.symbol,
          decimals: data.decimals || 9
        };
      }
    } catch (error) {
      logger.error({ error, mint: mint.toString() }, '获取代币信息失败');
    }
    return null;
  }

  private async logTransaction(
    tokenAddress: string,
    tokenSymbol: string,
    buyPrice: number,
    sellPrice: number,
    profitPercentage: number,
    volume: number,
    liquidity: number,
    transactionHash?: string
  ) {
    const timestamp = new Date().toISOString();
    const volatility = this.calculateVolatility(tokenAddress, buyPrice || sellPrice || 0.01);
    const solUsdtPrice = await this.getSolUsdtPrice();
    
    // 转换为 USDT 价格
    const buyPriceUsdt = buyPrice * solUsdtPrice;
    const sellPriceUsdt = sellPrice * solUsdtPrice;
    
    // 修正交易量计算
    const volumeInSol = volume / 1e9; // 转换为 SOL
    const volumeUsdt = volumeInSol * solUsdtPrice;
    
    // 修正流动性计算
    const liquidityInSol = liquidity / 1e9; // 转换为 SOL
    const liquidityUsdt = liquidityInSol * solUsdtPrice;
    
    const gasFeeUsdt = this.config.unitPrice * solUsdtPrice / 1e9;
    
    // 计算利润
    const profitUsdt = sellPriceUsdt - buyPriceUsdt;
    const actualProfitPercentage = buyPriceUsdt > 0 ? (profitUsdt / buyPriceUsdt) * 100 : 0;
    
    const trade: TradeRecord = {
      timestamp,
      token_address: tokenAddress,
      token_symbol: tokenSymbol,
      buy_price_usdt: buyPriceUsdt,
      sell_price_usdt: sellPriceUsdt,
      profit_percentage: actualProfitPercentage,
      volume_usdt: volumeUsdt,
      liquidity_usdt: liquidityUsdt,
      volatility,
      gas_fee_usdt: gasFeeUsdt,
      slippage: this.config.sellSlippage,
      transaction_hash: transactionHash,
      sol_usdt_price: solUsdtPrice
    };

    // 保存到内存中
    if (!this.tradeHistory[tokenAddress]) {
      this.tradeHistory[tokenAddress] = [];
    }
    this.tradeHistory[tokenAddress].push(trade);

    // 保存到文件
    const date = new Date().toISOString().split('T')[0];
    const dataPath = path.join(process.cwd(), 'data', `trades_${date}.json`);
    fs.appendFileSync(dataPath, JSON.stringify(trade) + '\n');

    // 更新 all_trades.json
    this.saveAllTradeData();

    // 格式化输出
    const timeAgo = this.getTimeAgo(new Date(timestamp));
    console.log(`
${buyPrice ? '买入' : '卖出'}

代币: ${tokenSymbol}
总价值: $${volumeUsdt.toFixed(2)}
数量: ${volumeInSol.toFixed(2)}
价格: $${(buyPriceUsdt || sellPriceUsdt).toFixed(6)}
${sellPrice ? `利润: ${profitUsdt >= 0 ? '+' : ''}$${profitUsdt.toFixed(2)}` : ''}
时间: ${timeAgo}
交易哈希: ${transactionHash}
    `);
  }

  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
    
    if (seconds < 60) {
      return `${seconds}秒前`;
    }
    
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}分钟前`;
    }
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}小时前`;
    }
    
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  }

  private calculateVolatility(tokenAddress: string, currentPrice: number): number {
    if (!this.priceHistory[tokenAddress]) {
      this.priceHistory[tokenAddress] = [];
    }

    this.priceHistory[tokenAddress].push(currentPrice);
    if (this.priceHistory[tokenAddress].length > 10) {
      this.priceHistory[tokenAddress].shift();
    }

    if (this.priceHistory[tokenAddress].length < 2) return 0.01;

    const returns = this.priceHistory[tokenAddress]
      .slice(1)
      .map((p, i) => (p - this.priceHistory[tokenAddress][i]) / this.priceHistory[tokenAddress][i]);
    
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance) || 0.01;
  }

  public saveAllTradeData() {
    const dataPath = path.join(process.cwd(), 'data', 'all_trades.json');
    fs.writeFileSync(dataPath, JSON.stringify(this.tradeHistory, null, 2));
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
          );

          if (result.confirmed) {
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );
            break;
          }

          logger.info(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: poolState.baseMint.toString(), error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      await this.priceMatch(tokenAmountIn, poolKeys);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          );

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );
            break;
          }

          logger.info(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          logger.debug({ mint: rawAccount.mint.toString(), error }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    // 获取代币信息
    const tokenInfo = await this.getTokenInfo(poolKeys.baseMint);
    const tokenSymbol = tokenInfo?.symbol || 'UNKNOWN';

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    const result = await this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);

    // 添加日志记录
    if (result.confirmed) {
      const tokenAddress = poolKeys.baseMint.toString();
      const quantity = amountIn.raw.toNumber();
      
      // 计算价格
      const priceSol = direction === 'buy'
        ? poolInfo.quoteReserve.toNumber() / poolInfo.baseReserve.toNumber()
        : poolInfo.baseReserve.toNumber() / poolInfo.quoteReserve.toNumber();
      
      const liquidity = poolInfo.baseReserve.toNumber() * poolInfo.quoteReserve.toNumber();
      
      // 计算买入和卖出价格
      const buyPrice = direction === 'buy' ? priceSol : 0;
      const sellPrice = direction === 'sell' ? priceSol : 0;
      
      await this.logTransaction(
        tokenAddress,
        tokenSymbol,
        buyPrice,
        sellPrice,
        0, // 初始利润百分比
        quantity,
        liquidity,
        result.signature
      );
    }

    return result;
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    const stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut;

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );

        if (amountOut.lt(stopLoss)) {
          break;
        }

        if (amountOut.gt(takeProfit)) {
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);
  }

  private formatNumber(num: number): string {
    if (num >= 1e12) {
      return `${(num / 1e12).toFixed(2)}T`;
    } else if (num >= 1e9) {
      return `${(num / 1e9).toFixed(2)}B`;
    } else if (num >= 1e6) {
      return `${(num / 1e6).toFixed(2)}M`;
    } else if (num >= 1e3) {
      return `${(num / 1e3).toFixed(2)}K`;
    }
    return num.toFixed(2);
  }
} 