import { Connection, PublicKey, Commitment, Finality } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import dotenv from 'dotenv';

// ���ػ�������
dotenv.config();

interface Trade {
    priceChange: number;
    volumeChange: number;
    liquidityChange: number;
    timeElapsed: number;
    profit: number;
    holdTime: number;
    tokenAddress: string;
    programId?: string;
    tokenSymbol?: string;
    tokenPrice?: number;
    tokenAmount?: number;
    totalValue?: number;
    profitLoss?: number;
    transactionType?: 'buy' | 'sell';
    type?: 'buy' | 'sell';
    price?: number;
    amount?: number;
}

interface TokenAnalysis {
    successRate: number;
    avgProfit: number;
    avgLoss: number;
    bestEntryPrice: number;
    bestExitPrice: number;
    optimalHoldTime: number;
    volumePattern: string;
    liquidityPattern: string;
}

interface TradePattern {
    wins: number;
    losses: number;
    totalProfit: number;
    totalLoss: number;
    bestEntryPrice: number;
    bestExitPrice: number;
    optimalHoldTime: number;
    successRate: number;
    profitFactor: number;
    averageProfit: number;
    averageLoss: number;
}

class QLearning {
    private qTable: Map<string, number>;
    private tradePatterns: Map<string, TradePattern>;
    private learningRate: number;
    private discountFactor: number;
    private explorationRate: number;
    private readonly qTablePath: string;
    private evolutionHistory: {
        generation: number;
        totalProfit: number;
        winRate: number;
        profitFactor: number;
        bestPatterns: string[];
    }[];

    constructor() {
        this.qTable = new Map();
        this.tradePatterns = new Map();
        this.learningRate = 0.1;
        this.discountFactor = 0.9;
        this.explorationRate = 0.1;
        this.qTablePath = path.join(__dirname, 'q-table.json');
        this.evolutionHistory = [];
        this.loadQTable();
    }

    private loadQTable(): void {
        try {
            if (fs.existsSync(this.qTablePath)) {
                const data = fs.readFileSync(this.qTablePath, 'utf-8');
                const parsed = JSON.parse(data);
                this.qTable = new Map(Object.entries(parsed));
                console.log('Loaded existing Q-table');
            } else {
                console.log('No existing Q-table found, starting fresh');
            }
        } catch (error) {
            console.error('Error loading Q-table:', error);
            this.qTable = new Map();
        }
    }

    private saveQTable(): void {
        try {
            const data = JSON.stringify(Object.fromEntries(this.qTable));
            fs.writeFileSync(this.qTablePath, data);
            console.log('Saved Q-table');
        } catch (error) {
            console.error('Error saving Q-table:', error);
        }
    }

    private getStateKey(trade: Trade): string {
        // �����ܵ�״̬���壬���Ǹ���ӯ������
        const priceChange = Math.round(trade.priceChange * 100) / 100;
        const volumeChange = Math.round(trade.volumeChange * 100) / 100;
        const liquidityChange = Math.round(trade.liquidityChange * 100) / 100;
        const timeElapsed = Math.round(trade.timeElapsed / 60000);
        const tokenSymbol = trade.tokenSymbol || 'Unknown';
        const profitLoss = trade.profitLoss || 0;
        
        // ���ӯ��״̬
        const profitState = profitLoss > 0 ? 'profit' : profitLoss < 0 ? 'loss' : 'neutral';
        
        return `${tokenSymbol}_${priceChange}_${volumeChange}_${liquidityChange}_${timeElapsed}_${profitState}`;
    }

    private getAction(trade: Trade): number {
        const stateKey = this.getStateKey(trade);
        const currentQ = this.qTable.get(stateKey) || 0;
        
        if (Math.random() < this.explorationRate) {
            return Math.random() < 0.5 ? 1 : -1;
        }
        
        return currentQ > 0 ? 1 : -1;
    }

    public updateQValue(state: string, action: number, reward: number, nextState: string): void {
        const currentQ = this.qTable.get(state) || 0;
        const nextQ = this.qTable.get(nextState) || 0;
        
        const newQ = currentQ + this.learningRate * (reward + this.discountFactor * nextQ - currentQ);
        this.qTable.set(state, newQ);
        
        // ���� Q-Learning ģ��
        this.saveQTable();
    }

    public analyzeTradePatterns(trades: Trade[]): void {
        // �����ҷ������
        const tokenPatterns = new Map<string, {
            totalTrades: number,
            profitableTrades: number,
            totalProfit: number,
            totalLoss: number,
            bestEntryPrice: number,
            bestExitPrice: number,
            optimalHoldTime: number,
            successRate: number,
            profitFactor: number,
            averageProfit: number,
            averageLoss: number
        }>();

        trades.forEach(trade => {
            const tokenKey = trade.tokenAddress;
            if (!tokenPatterns.has(tokenKey)) {
                tokenPatterns.set(tokenKey, {
                    totalTrades: 0,
                    profitableTrades: 0,
                    totalProfit: 0,
                    totalLoss: 0,
                    bestEntryPrice: 0,
                    bestExitPrice: 0,
                    optimalHoldTime: 0,
                    successRate: 0,
                    profitFactor: 0,
                    averageProfit: 0,
                    averageLoss: 0
                });
            }

            const pattern = tokenPatterns.get(tokenKey)!;
            pattern.totalTrades++;

            const profitLoss = trade.profitLoss || 0;
            if (profitLoss > 0) {
                pattern.profitableTrades++;
                pattern.totalProfit += profitLoss;
                if (profitLoss > pattern.bestExitPrice) {
                    pattern.bestExitPrice = profitLoss;
                }
            } else {
                pattern.totalLoss += Math.abs(profitLoss);
            }

            // ��������볡�۸�
            if (pattern.bestEntryPrice === 0 || trade.priceChange < pattern.bestEntryPrice) {
                pattern.bestEntryPrice = trade.priceChange;
            }

            // ������ѳֲ�ʱ��
            const holdTime = trade.timeElapsed / (60 * 1000); // ת��Ϊ����
            if (profitLoss > 0 && (pattern.optimalHoldTime === 0 || holdTime < pattern.optimalHoldTime)) {
                pattern.optimalHoldTime = holdTime;
            }
        });

        // ����ͳ������
        tokenPatterns.forEach((pattern, tokenKey) => {
            pattern.successRate = (pattern.profitableTrades / pattern.totalTrades) * 100;
            pattern.profitFactor = pattern.totalProfit / (pattern.totalLoss || 1);
            pattern.averageProfit = pattern.totalProfit / pattern.profitableTrades;
            pattern.averageLoss = pattern.totalLoss / (pattern.totalTrades - pattern.profitableTrades);

            // ���½���ģʽ
            this.tradePatterns.set(tokenKey, {
                wins: 0,
                losses: 0,
                totalProfit: 0,
                totalLoss: 0,
                bestEntryPrice: pattern.bestEntryPrice,
                bestExitPrice: pattern.bestExitPrice,
                optimalHoldTime: pattern.optimalHoldTime,
                successRate: pattern.successRate,
                profitFactor: pattern.profitFactor,
                averageProfit: pattern.averageProfit,
                averageLoss: pattern.averageLoss
            });
        });

        // ����������
        saveToFile(Array.from(this.tradePatterns.entries()), 'trade-patterns.json');
    }

    private recordEvolution(trades: Trade[]): void {
        const totalProfit = trades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
        const winRate = trades.filter(t => t.profitLoss && t.profitLoss > 0).length / trades.length;
        const profitFactor = this.calculateProfitFactor(trades);
        
        // ��ȡ���ģʽ
        const bestPatterns = Array.from(this.tradePatterns.entries())
            .sort((a, b) => b[1].profitFactor - a[1].profitFactor)
            .slice(0, 3)
            .map(([pattern]) => pattern);

        this.evolutionHistory.push({
            generation: this.evolutionHistory.length + 1,
            totalProfit,
            winRate,
            profitFactor,
            bestPatterns
        });

        console.log('\n������ʷ:');
        this.evolutionHistory.forEach(gen => {
            console.log(`\n�� ${gen.generation} ��:
��ӯ��: $${gen.totalProfit.toFixed(2)}
ʤ��: ${(gen.winRate * 100).toFixed(2)}%
ӯ������: ${gen.profitFactor.toFixed(2)}
���ģʽ: ${gen.bestPatterns.join(', ')}`);
        });
    }

    private calculateProfitFactor(trades: Trade[]): number {
        const totalProfit = trades
            .filter(t => t.profitLoss && t.profitLoss > 0)
            .reduce((sum, t) => sum + (t.profitLoss || 0), 0);
        
        const totalLoss = trades
            .filter(t => t.profitLoss && t.profitLoss < 0)
            .reduce((sum, t) => sum + Math.abs(t.profitLoss || 0), 0);
        
        return totalLoss > 0 ? totalProfit / totalLoss : totalProfit;
    }

    public train(trades: Trade[]): void {
        console.log('\n��ʼѵ�� Q-Learning ģ��...');
        
        // ������ʷ���ֵ���ѧϰ����
        this.adjustLearningParameters(trades);
        
        for (let i = 0; i < trades.length - 1; i++) {
            const currentTrade = trades[i];
            const nextTrade = trades[i + 1];
            
            const currentState = this.getStateKey(currentTrade);
            const nextState = this.getStateKey(nextTrade);
            
            const action = this.getAction(currentTrade);
            const reward = this.calculateReward(currentTrade);
            
            this.updateQValue(currentState, action, reward, nextState);
        }
        
        this.saveQTable();
        console.log('ѵ�����');
        
        // ��������ģʽ
        this.analyzeTradePatterns(trades);
        
        // ����Ż�����
        this.generateOptimizationSuggestions(trades);
    }

    private calculateReward(trade: Trade): number {
        // ����ʵ��ӯ��
        const profitLoss = trade.profitLoss || 0;
        const profitPercentage = (profitLoss / (trade.priceChange || 0)) * 100;

        // ��������
        let reward = profitLoss;

        // ����ӯ���ٷֱȵ�������
        if (profitPercentage > 0) {
            // ӯ������
            if (profitPercentage > 50) {
                reward *= 2; // ���ӯ���ӱ�����
            } else if (profitPercentage > 20) {
                reward *= 1.5; // �е�ӯ������50%����
            }
        } else {
            // ������
            if (profitPercentage < -50) {
                reward *= 2; // �������ӱ��ͷ�
            } else if (profitPercentage < -20) {
                reward *= 1.5; // �еȿ�������50%�ͷ�
            }
        }

        // ���ݳֲ�ʱ���������
        const holdTimeMinutes = trade.timeElapsed / (60 * 1000);
        if (holdTimeMinutes > 30) {
            // �ֲ�ʱ����������ͽ���
            reward *= 0.8;
        } else if (holdTimeMinutes < 5) {
            // �ֲ�ʱ����̣����ӽ���
            reward *= 1.2;
        }

        return reward;
    }

    private adjustLearningParameters(trades: Trade[]): void {
        const recentPerformance = this.calculateProfitFactor(trades.slice(-10));
        
        // ����������ֵ���ѧϰ��
        if (recentPerformance > 2) {
            this.learningRate *= 0.9; // ���ֺ�ʱ����ѧϰ��
        } else {
            this.learningRate *= 1.1; // ���ֲ�ʱ���ѧϰ��
        }
        
        // ����ʤ�ʵ���̽����
        const winRate = trades.filter(t => t.profitLoss && t.profitLoss > 0).length / trades.length;
        this.explorationRate = Math.max(0.05, Math.min(0.3, 1 - winRate));
        
        console.log(`\n�������ѧϰ����:
ѧϰ��: ${this.learningRate.toFixed(3)}
̽����: ${this.explorationRate.toFixed(3)}`);
    }

    private generateOptimizationSuggestions(trades: Trade[]): void {
        console.log('\n�Ż�����:');
        
        // ��������볡ʱ��
        const profitableTrades = trades.filter(t => t.profitLoss && t.profitLoss > 0);
        const bestEntryPrices = profitableTrades.map(t => t.priceChange).filter(p => p !== undefined);
        const avgBestEntryPrice = bestEntryPrices.reduce((a, b) => a + b, 0) / bestEntryPrices.length;
        
        // ������ѳ���ʱ��
        const bestExitPrices = profitableTrades.map(t => t.priceChange).filter(p => p !== undefined);
        const avgBestExitPrice = bestExitPrices.reduce((a, b) => a + b, 0) / bestExitPrices.length;
        
        // ������ѳֲ�ʱ��
        const profitableHoldTimes = profitableTrades.map(t => t.timeElapsed);
        const avgProfitableHoldTime = profitableHoldTimes.reduce((a, b) => a + b, 0) / profitableHoldTimes.length;
        
        console.log(`1. ����볡�۸�: $${avgBestEntryPrice.toFixed(6)}`);
        console.log(`2. ��ѳ����۸�: $${avgBestExitPrice.toFixed(6)}`);
        console.log(`3. ����ֲ�ʱ��: ${Math.round(avgProfitableHoldTime / 60000)} ����`);
        
        // ����������ģʽ
        const profitableVolumes = profitableTrades.map(t => t.volumeChange);
        const avgProfitableVolume = profitableVolumes.reduce((a, b) => a + b, 0) / profitableVolumes.length;
        console.log(`4. ���齻����: ${avgProfitableVolume.toFixed(4)} SOL`);
        
        // ���������Ա仯
        const profitableLiquidityChanges = profitableTrades.map(t => t.liquidityChange);
        const avgProfitableLiquidityChange = profitableLiquidityChanges.reduce((a, b) => a + b, 0) / profitableLiquidityChanges.length;
        console.log(`5. ���������Ա仯��ֵ: ${avgProfitableLiquidityChange.toFixed(2)}%`);
    }

    public getOptimalAction(trade: Trade): number {
        const stateKey = this.getStateKey(trade);
        const qValue = this.qTable.get(stateKey) || 0;
        return qValue > 0 ? 1 : -1;
    }
}

// ��Ӵ�����Ϣӳ��
const TOKEN_INFO: { [key: string]: { symbol: string; decimals: number } } = {
    'FLiPgGTXtBtEJoytikaywvWgbz5a56DdHKZU72HSYMFF': { symbol: 'TCC', decimals: 9 },
    'CiY66RinNqariSNNs3axJ5qSimN814tzhVJgfvGuKABR': { symbol: 'TCC', decimals: 9 }
};

function calculateTokenDetails(tx: any): { tokenAmount: number; tokenPrice: number; totalValue: number; tokenSymbol: string } {
    try {
        const tokenAddress = analyzeTokenAddress(tx);
        const tokenInfo = TOKEN_INFO[tokenAddress] || { symbol: 'Unknown', decimals: 9 };
        
        // �ӽ�����������ȡ��������
        let tokenAmount = 0;
        if (tx.meta && tx.meta.postTokenBalances && tx.meta.postTokenBalances.length > 0) {
            tokenAmount = tx.meta.postTokenBalances[0].uiTokenAmount.uiAmount || 0;
        }

        // ������Ҽ۸�
        let tokenPrice = 0;
        let totalValue = 0;
        
        if (tx.meta && tx.meta.preBalances && tx.meta.postBalances) {
            const solChange = Math.abs(tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            if (tokenAmount > 0) {
                tokenPrice = solChange / tokenAmount;
                totalValue = solChange;
            }
        }

        return {
            tokenAmount,
            tokenPrice,
            totalValue,
            tokenSymbol: tokenInfo.symbol
        };
    } catch (e) {
        console.error('Error calculating token details:', e);
        return {
            tokenAmount: 0,
            tokenPrice: 0,
            totalValue: 0,
            tokenSymbol: 'Unknown'
        };
    }
}

// ����ļ����溯��
function saveToFile(data: any, filename: string): void {
    try {
        const dir = './data';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`�����ļ� ${filename} ʧ��:`, error);
    }
}

// �����־��¼����
function logToFile(message: string): void {
    try {
        const dir = './data';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}\n`;
        fs.appendFileSync(path.join(dir, 'trading-bot.log'), logMessage);
    } catch (error) {
        console.error('д����־ʧ��:', error);
    }
}

async function fetchTradeData(walletAddress: string): Promise<Trade[]> {
    try {
        logToFile('Starting to fetch transaction data...');
        console.log('Connecting to Solana network...');
        
        // ʹ�ñ��� Solana CLI ����
        const solanaPath = '/root/solana-release/bin/solana';
        
        // ��ȡ������ʷ
        const { stdout: signaturesOutput } = await new Promise<{ stdout: string }>((resolve, reject) => {
            exec(`${solanaPath} confirm -v ${walletAddress} --output json`, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout });
            });
        });

        const signatures = JSON.parse(signaturesOutput);
        console.log(`Found ${signatures.length} transactions`);

        const trades: Trade[] = [];

        // ����ÿ�ʽ���
        for (const sig of signatures) {
            try {
                console.log(`\nAnalyzing transaction: ${sig.signature}`);
                
                // ��ȡ��������
                const { stdout: txOutput } = await new Promise<{ stdout: string }>((resolve, reject) => {
                    exec(`${solanaPath} confirm -v ${sig.signature} --output json`, (error, stdout, stderr) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        resolve({ stdout });
                    });
                });

                const tx = JSON.parse(txOutput);
                
                if (tx && tx.meta) {
                    // ����۸�仯
                    const preBalances = tx.meta.preBalances;
                    const postBalances = tx.meta.postBalances;
                    const priceChange = calculatePriceChange(preBalances, postBalances);
                    
                    // ���㽻����
                    const volume = calculateVolume(tx);
                    
                    // ���������Ա仯
                    const liquidityChange = calculateLiquidityChange(tx);
                    
                    // ����ʱ��
                    const timeElapsed = Date.now() - (tx.blockTime || 0) * 1000;
                    
                    // �������Һ�Լ��ַ
                    const tokenAddress = analyzeTokenAddress(tx);
                    const accountKeys = tx.transaction?.message?.getAccountKeys();
                    const programId = accountKeys?.get(0)?.toBase58() || 'Unknown';
                    
                    // ������������
                    const transactionType = analyzeTransactionType(tx);
                    
                    // ������������ͼ۸�
                    const { tokenAmount, tokenPrice, totalValue, tokenSymbol } = calculateTokenDetails(tx);
                    
                    // ����ӯ��
                    const profitLoss = calculateProfitLoss(tx, transactionType, walletAddress);

                    console.log(`\nTransaction Analysis:
Token: ${tokenSymbol} (${tokenAddress.slice(0, 8)}...${tokenAddress.slice(-8)})
Type: ${transactionType}
Price: $${tokenPrice.toFixed(6)}
Amount: ${tokenAmount.toFixed(2)}
Total Value: $${totalValue.toFixed(2)}
Profit/Loss: ${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)}
Time: ${formatTimeElapsed(timeElapsed)}
----------------------------------------`);

                    trades.push({
                        priceChange,
                        volumeChange: volume,
                        liquidityChange,
                        timeElapsed,
                        profit: priceChange > 0 ? priceChange : 0,
                        holdTime: timeElapsed,
                        tokenAddress,
                        programId,
                        tokenSymbol,
                        tokenPrice,
                        tokenAmount,
                        totalValue,
                        profitLoss,
                        transactionType
                    });
                }
                
                // ����ӳ��Ա����������
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (e) {
                console.log(`Error processing transaction ${sig.signature}:`, e);
            }
        }
        
        console.log(`\nSuccessfully analyzed ${trades.length} transactions`);
        
        // ��ʱ������
        trades.sort((a, b) => b.timeElapsed - a.timeElapsed);
        
        // �������ͳ��
        const totalProfit = trades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
        const profitableTrades = trades.filter(t => t.profitLoss && t.profitLoss > 0);
        const losingTrades = trades.filter(t => t.profitLoss && t.profitLoss < 0);
        
        console.log('\nTransaction Statistics:');
        console.log(`Total Transactions: ${trades.length}`);
        console.log(`Profitable Trades: ${profitableTrades.length}`);
        console.log(`Losing Trades: ${losingTrades.length}`);
        console.log(`Total Profit/Loss: $${totalProfit.toFixed(2)}`);
        console.log(`Win Rate: ${((profitableTrades.length / trades.length) * 100).toFixed(2)}%`);
        
        // ���潻�׼�¼
        saveToFile(trades, 'trades.json');
        logToFile(`Successfully saved ${trades.length} transaction records`);
        
        return trades;
    } catch (error: unknown) {
        if (error instanceof Error) {
            logToFile(`Failed to fetch transaction data: ${error.message}`);
        } else {
            logToFile('Failed to fetch transaction data: Unknown error');
        }
        return [];
    }
}

function calculatePriceChange(preBalances: number[], postBalances: number[]): number {
    try {
        const preTotal = preBalances.reduce((a, b) => a + b, 0);
        const postTotal = postBalances.reduce((a, b) => a + b, 0);
        if (preTotal === 0) return 0;
        return ((postTotal - preTotal) / preTotal) * 100;
    } catch (e) {
        console.error('Error calculating price change:', e);
        return 0;
    }
}

function calculateVolume(tx: any): number {
    try {
        const preBalance = tx.meta?.preBalances[0] || 0;
        const postBalance = tx.meta?.postBalances[0] || 0;
        const volume = Math.abs(postBalance - preBalance) / 1e9; // ת��Ϊ SOL
        return volume;
    } catch (e) {
        console.error('Error calculating volume:', e);
        return 0;
    }
}

function calculateLiquidityChange(tx: any): number {
    try {
        if (!tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
            return 0;
        }

        const preTotal = tx.meta.preBalances.reduce((a: number, b: number) => a + b, 0);
        const postTotal = tx.meta.postBalances.reduce((a: number, b: number) => a + b, 0);
        
        if (preTotal === 0) return 0;
        return ((postTotal - preTotal) / preTotal) * 100;
    } catch (e) {
        console.error('Error calculating liquidity change:', e);
        return 0;
    }
}

// �Ľ����ҵ�ַ��������
function analyzeTokenAddress(tx: any): string {
    try {
        if (!tx || !tx.transaction || !tx.transaction.message) {
            return 'Unknown';
        }

        // ��ȡ�����˻���ַ
        const accountKeys = tx.transaction.message.getAccountKeys();
        if (!accountKeys || accountKeys.length === 0) {
            return 'Unknown';
        }

        // ��ȡ����ID
        const programId = accountKeys.get(0)?.toBase58() || 'Unknown';
        
        // ��ȡ�����˻�
        const tokenAccounts = accountKeys.staticAccountKeys.filter((key: any) => {
            return key.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        });

        if (tokenAccounts.length > 0) {
            // ��ȡ���������ַ
            const mintAddress = tokenAccounts[0].toBase58();
            console.log(`Found token mint address: ${mintAddress}`);
            return mintAddress;
        }

        // ���û���ҵ������˻������Դ�ָ���л�ȡ
        if (tx.meta && tx.meta.innerInstructions) {
            for (const inner of tx.meta.innerInstructions) {
                if (inner.instructions) {
                    for (const instruction of inner.instructions) {
                        if (instruction.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                            const mintAddress = instruction.accounts[1];
                            if (mintAddress) {
                                console.log(`Found token mint address from instruction: ${mintAddress}`);
                                return mintAddress;
                            }
                        }
                    }
                }
            }
        }

        // �������û���ҵ������س���ID
        console.log(`Using program ID as token address: ${programId}`);
        return programId;
    } catch (e) {
        console.error('Error analyzing token address:', e);
        return 'Unknown';
    }
}

// ����µĸ�������
function analyzeTransactionType(tx: any): 'buy' | 'sell' {
    try {
        // ���ݽ���ָ������仯�жϽ�������
        const preBalance = tx.meta?.preBalances[0] || 0;
        const postBalance = tx.meta?.postBalances[0] || 0;
        return postBalance < preBalance ? 'sell' : 'buy';
    } catch (e) {
        console.error('Error analyzing transaction type:', e);
        return 'buy';
    }
}

function calculateProfitLoss(tx: any, type: 'buy' | 'sell', walletAddress: string): number {
    try {
        if (!tx.meta) return 0;

        // ��ȡ�������仯
        let tokenAmountChange = 0;
        let preBalance = 0;
        let postBalance = 0;

        // ���Ҵ������仯
        if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
            const preTokenBalance = tx.meta.preTokenBalances.find(
                (b: any) => b.owner === walletAddress
            );
            const postTokenBalance = tx.meta.postTokenBalances.find(
                (b: any) => b.owner === walletAddress
            );

            if (preTokenBalance && postTokenBalance) {
                preBalance = Number(preTokenBalance.uiTokenAmount.uiAmount) || 0;
                postBalance = Number(postTokenBalance.uiTokenAmount.uiAmount) || 0;
                tokenAmountChange = postBalance - preBalance;
            }
        }

        // ��ȡ SOL ���仯
        let solChange = 0;
        if (tx.meta.preBalances && tx.meta.postBalances) {
            const walletIndex = tx.transaction.message.accountKeys.findIndex(
                (key: any) => key.toBase58() === walletAddress
            );
            
            if (walletIndex >= 0) {
                const preSolBalance = tx.meta.preBalances[walletIndex] || 0;
                const postSolBalance = tx.meta.postBalances[walletIndex] || 0;
                solChange = (postSolBalance - preSolBalance) / 1e9;
            }
        }

        // ���㽻�׷���
        const fee = tx.meta.fee / 1e9;

        // ����ʵ��ӯ��
        let profitLoss = 0;
        if (type === 'buy') {
            // ���룺֧�� SOL����ô���
            profitLoss = -solChange - fee;
        } else {
            // ��������� SOL��֧������
            profitLoss = solChange - fee;
        }

        // ��¼��ϸ��־
        console.log(`\nTransaction Details:
Type: ${type}
Token Change: ${tokenAmountChange}
SOL Change: ${solChange}
Fee: ${fee}
Profit/Loss: ${profitLoss}`);

        return profitLoss;
    } catch (error) {
        console.error('Error calculating profit/loss:', error);
        return 0;
    }
}

function formatTimeElapsed(timeElapsed: number): string {
    const minutes = Math.floor(timeElapsed / 1000 / 60);
    return `${minutes}m ago`;
}

async function optimizeConfig(trades: Trade[]): Promise<void> {
    const qLearning = new QLearning();
    qLearning.train(trades);
    
    // ������������
    const analysis = analyzeTrades(trades);
    
    // ���������ļ�
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf-8');
    
    // ����ֹӯֹ��
    envContent = envContent.replace(
        /TAKE_PROFIT=\d+/,
        `TAKE_PROFIT=${Math.round(analysis.avgProfit * 1.5)}`
    );
    envContent = envContent.replace(
        /STOP_LOSS=\d+/,
        `STOP_LOSS=${Math.round(Math.abs(analysis.avgLoss) * 1.2)}`
    );
    
    // ������������
    envContent = envContent.replace(
        /SELL_PERCENTAGE=\d+/,
        `SELL_PERCENTAGE=${Math.round(analysis.successRate * 100)}`
    );
    
    fs.writeFileSync(envPath, envContent);
    console.log('�����ļ��Ѹ���');
}

function analyzeTrades(trades: Trade[]): TokenAnalysis {
    const profitableTrades = trades.filter(t => t.profit > 0);
    const losingTrades = trades.filter(t => t.profit <= 0);
    
    return {
        successRate: profitableTrades.length / trades.length,
        avgProfit: profitableTrades.reduce((sum, t) => sum + t.profit, 0) / profitableTrades.length,
        avgLoss: losingTrades.reduce((sum, t) => sum + t.profit, 0) / losingTrades.length,
        bestEntryPrice: Math.min(...trades.map(t => t.priceChange)),
        bestExitPrice: Math.max(...trades.map(t => t.priceChange)),
        optimalHoldTime: trades.reduce((sum, t) => sum + t.timeElapsed, 0) / trades.length,
        volumePattern: 'stable',
        liquidityPattern: 'stable'
    };
}

async function restartBot(): Promise<void> {
    return new Promise((resolve, reject) => {
        exec('npm start', (error, stdout, stderr) => {
            if (error) {
                console.error('����������ʧ��:', error);
                reject(error);
                return;
            }
            console.log('������������');
            resolve();
        });
    });
}

// ��� calculateReward ����
function calculateReward(profitLoss: number, timeElapsed: number): number {
    // ������������ӯ��
    let reward = profitLoss;
    
    // ���ݳֲ�ʱ���������
    const holdTimeMinutes = timeElapsed / (60 * 1000);
    if (holdTimeMinutes > 30) {
        // �ֲ�ʱ����������ͽ���
        reward *= 0.8;
    } else if (holdTimeMinutes < 5) {
        // �ֲ�ʱ����̣����ӽ���
        reward *= 1.2;
    }
    
    return reward;
}

async function monitorNewTrades(walletAddress: string): Promise<void> {
    try {
        logToFile('Starting to monitor new trades...');
        console.log('Connecting to Solana network...');
        
        // ���� QLearning ʵ��
        const qLearning = new QLearning();
        
        const rpcEndpoint = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
        const wsEndpoint = process.env.RPC_WEBSOCKET_ENDPOINT || 'wss://api.mainnet-beta.solana.com';
        const commitment = (process.env.COMMITMENT_LEVEL || 'confirmed') as Finality;
        
        const connection = new Connection(rpcEndpoint, {
            commitment,
            confirmTransactionInitialTimeout: 120000,
            wsEndpoint
        });
        
        const publicKey = new PublicKey(walletAddress);
        
        // ��ȡ���µĽ���ǩ����Ϊ���
        const signatures = await connection.getSignaturesForAddress(
            publicKey,
            { limit: 1 }
        );
        
        if (signatures.length === 0) {
            throw new Error('No transaction history found');
        }
        
        const lastSignature = signatures[0].signature;
        console.log(`Starting monitoring from signature: ${lastSignature}`);
        
        // �����˻��仯
        const subscriptionId = connection.onAccountChange(
            publicKey,
            async (accountInfo) => {
                try {
                    // ��ȡ���µĽ���
                    const newSignatures = await connection.getSignaturesForAddress(
                        publicKey,
                        { limit: 5 }
                    );
                    
                    // �����½���
                    for (const sig of newSignatures) {
                        if (sig.signature === lastSignature) {
                            continue; // �����Ѵ���Ľ���
                        }
                        
                        console.log(`\nAnalyzing new transaction: ${sig.signature}`);
                        
                        const tx = await connection.getTransaction(sig.signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment
                        });
                        
                        if (tx && tx.meta) {
                            // ����۸�仯
                            const preBalances = tx.meta.preBalances;
                            const postBalances = tx.meta.postBalances;
                            const priceChange = calculatePriceChange(preBalances, postBalances);
                            
                            // ���㽻����
                            const volume = calculateVolume(tx);
                            
                            // ���������Ա仯
                            const liquidityChange = calculateLiquidityChange(tx);
                            
                            // ����ʱ��
                            const timeElapsed = Date.now() - (tx.blockTime || 0) * 1000;
                            
                            // �������Һ�Լ��ַ
                            const tokenAddress = analyzeTokenAddress(tx);
                            const accountKeys = tx.transaction?.message?.getAccountKeys();
                            const programId = accountKeys?.get(0)?.toBase58() || 'Unknown';
                            
                            // ������������
                            const transactionType = analyzeTransactionType(tx);
                            
                            // ������������ͼ۸�
                            const { tokenAmount, tokenPrice, totalValue, tokenSymbol } = calculateTokenDetails(tx);
                            
                            // ����ӯ��
                            const profitLoss = calculateProfitLoss(tx, transactionType, walletAddress);
                            
                            console.log(`\nNew Transaction Analysis:
Token: ${tokenSymbol} (${tokenAddress.slice(0, 8)}...${tokenAddress.slice(-8)})
Type: ${transactionType}
Price: $${tokenPrice.toFixed(6)}
Amount: ${tokenAmount.toFixed(2)}
Total Value: $${totalValue.toFixed(2)}
Profit/Loss: ${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)}
Time: ${formatTimeElapsed(timeElapsed)}
----------------------------------------`);
                            
                            // ���� Q ֵ
                            const state = {
                                priceChange,
                                volumeChange: volume,
                                liquidityChange,
                                timeElapsed
                            };
                            
                            const action = transactionType === 'buy' ? 0 : 1;
                            const reward = calculateReward(profitLoss, timeElapsed);
                            
                            qLearning.updateQValue(JSON.stringify(state), action, reward, JSON.stringify(state));
                            
                            // ���潻�׼�¼
                            const trade: Trade = {
                                priceChange,
                                volumeChange: volume,
                                liquidityChange,
                                timeElapsed,
                                profit: priceChange > 0 ? priceChange : 0,
                                holdTime: timeElapsed,
                                tokenAddress,
                                programId,
                                tokenSymbol,
                                tokenPrice,
                                tokenAmount,
                                totalValue,
                                profitLoss,
                                transactionType
                            };
                            
                            saveToFile([trade], 'trades.json');
                            logToFile(`New trade saved: ${sig.signature}`);
                        }
                    }
                } catch (e) {
                    console.log('Error processing new transaction:', e);
                }
            },
            commitment
        );
        
        console.log('Successfully started monitoring new trades');
        logToFile('Successfully started monitoring new trades');
        
        // ���ֳ�������
        process.on('SIGINT', () => {
            console.log('Stopping trade monitoring...');
            connection.removeAccountChangeListener(subscriptionId);
            process.exit(0);
        });
        
    } catch (error: unknown) {
        if (error instanceof Error) {
            logToFile(`Failed to start monitoring: ${error.message}`);
        } else {
            logToFile('Failed to start monitoring: Unknown error');
        }
    }
}

async function main() {
    const walletAddress = 'CiY66RinNqariSNNs3axJ5qSimN814tzhVJgfvGuKABR';
    
    try {
        // ���Ȼ�ȡ��ʷ����
        console.log('��ȡ��ʷ��������...');
        const trades = await fetchTradeData(walletAddress);
        
        if (trades.length > 0) {
            // ������ʷ����
            await optimizeConfig(trades);
            
            // ��ʼ����½���
            await monitorNewTrades(walletAddress);
        } else {
            console.log('δ�ҵ���ʷ���ף�ʹ��Ĭ�����ò���ʼ����½���');
            await monitorNewTrades(walletAddress);
        }
    } catch (error) {
        console.error('����ִ�д���:', error);
    }
}

main(); 