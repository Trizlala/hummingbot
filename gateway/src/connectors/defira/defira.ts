import {
  InitializationError,
  SERVICE_UNITIALIZED_ERROR_CODE,
  SERVICE_UNITIALIZED_ERROR_MESSAGE,
  UniswapishPriceError,
} from '../../services/error-handler';
import { isFractionString } from '../../services/validators';
import { DefiraConfig } from './defira.config';
import routerAbi from './defira_v2_router_abi.json';
import {
  Contract,
  ContractInterface,
  ContractTransaction,
} from '@ethersproject/contracts';
import {
  // TODO: use this instead of UniswapRouter
  Router,
  // TODO: use this instead of UniswapPair. Note that its constructor takes in an optional factory address
  // parameter that SHOULD be populated since the default only works for mainnet
  Pair,
  SwapParameters,
  // TODO: use this instead of UniswapTrade
  Trade,
} from '@zuzu-cat/defira-sdk';

import {
  // TODO: use this instead of UniswapRouter
  Router as UniswapRouter,
  // TODO: use @uniswap/sdk-core Percent instead of this one
  Percent as UniswapPercent,
  // TODO: use @uniswap/sdk-core Token instead of this one
  Token as UniswapToken,
  // TODO: use @uniswap/sdk-core CurrencyAmount instead of this one
  TokenAmount as UniswapTokenAmount,
  // TODO: use defira-sdk Pair instead of this one once defira-sdk Fetcher is hooked in
  Pair as UniswapPair,
  // TODO: use defira-sdk Fetcher instead of this one
  Fetcher as UniswapFetcher,
  // TODO: use defira-sdk Trade instead of this one
  Trade as UniswapTrade,
} from '@uniswap/sdk';
import {
  // TODO: use this instead of UniswapPercent
  Percent,
  // TODO: use this instead of UniswapTokenAmount
  CurrencyAmount,
  // TODO: use this for some generic parameters
  TradeType,
} from '@uniswap/sdk-core';
import { BigNumber, Transaction, Wallet } from 'ethers';
import { logger } from '../../services/logger';
import { percentRegexp } from '../../services/config-manager-v2';
import { Harmony } from '../../chains/harmony/harmony';
import { ExpectedTrade, Uniswapish } from '../../services/common-interfaces';

export class Defira implements Uniswapish {
  private static _instances: { [name: string]: Defira };
  private harmony: Harmony;
  private _chain: string;
  private _router: string;
  private _factory: string | null;
  private _routerAbi: ContractInterface;
  private _gasLimit: number;
  private _ttl: number;
  private chainId;
  private tokenList: Record<string, UniswapToken> = {};
  private _ready: boolean = false;

  private constructor(chain: string, network: string) {
    this._chain = chain;
    const config = DefiraConfig.config;
    this.harmony = Harmony.getInstance(network);
    this.chainId = this.harmony.chainId;
    this._ttl = DefiraConfig.config.ttl();
    this._routerAbi = routerAbi.abi;
    this._gasLimit = DefiraConfig.config.gasLimit();
    this._router = config.routerAddress(network);
    this._factory = null;
  }

  public static getInstance(chain: string, network: string): Defira {
    if (Defira._instances === undefined) {
      Defira._instances = {};
    }
    if (!(chain + network in Defira._instances)) {
      Defira._instances[chain + network] = new Defira(chain, network);
    }

    return Defira._instances[chain + network];
  }

  /**
   * Given a token's address, return the connector's native representation of
   * the token.
   *
   * @param address Token address
   */
  public getTokenByAddress(address: string): UniswapToken {
    return this.tokenList[address];
  }

  public async init() {
    if (this._chain == 'harmony' && !this.harmony.ready())
      throw new InitializationError(
        SERVICE_UNITIALIZED_ERROR_MESSAGE('HMY'),
        SERVICE_UNITIALIZED_ERROR_CODE
      );
    for (const token of this.harmony.storedTokenList) {
      this.tokenList[token.address] = new UniswapToken(
        this.chainId,
        token.address,
        token.decimals,
        token.symbol,
        token.name
      );
    }
    this._ready = true;
  }

  public ready(): boolean {
    return this._ready;
  }

  /**
   * Router address.
   */
  public get router(): string {
    return this._router;
  }

  /**
   * Lazily computed factory address. 
   * TODO: pass this value into the defira-sdk Fetcher to remove dependency on hard-coded contract address
   */
  public async factory(): Promise<string> {
    if (!this._factory) {
       const routerContract = new Contract(this.router, this.routerAbi, this.harmony.provider);
       this._factory = await routerContract.factory();
    }
    return this._factory as string;
  }

  /**
   * Router smart contract ABI.
   */
  public get routerAbi(): ContractInterface {
    return this._routerAbi;
  }

  /**
   * Default gas limit for swap transactions.
   */
  public get gasLimit(): number {
    return this._gasLimit;
  }

  /**
   * Default time-to-live for swap transactions, in seconds.
   */
  public get ttl(): number {
    return this._ttl;
  }

  /**
   * Gets the allowed slippage percent from the optional parameter or the value
   * in the configuration.
   *
   * @param allowedSlippageStr (Optional) should be of the form '1/10'.
   */
  public getAllowedSlippage(allowedSlippageStr?: string): UniswapPercent {
    if (allowedSlippageStr != null && isFractionString(allowedSlippageStr)) {
      const fractionSplit = allowedSlippageStr.split('/');
      return new UniswapPercent(fractionSplit[0], fractionSplit[1]);
    }

    const allowedSlippage = DefiraConfig.config.allowedSlippage();
    const nd = allowedSlippage.match(percentRegexp);
    if (nd) return new UniswapPercent(nd[1], nd[2]);
    throw new Error(
      'Encountered a malformed percent string in the config for ALLOWED_SLIPPAGE.'
    );
  }

  /**
   * Given the amount of `baseToken` to put into a transaction, calculate the
   * amount of `quoteToken` that can be expected from the transaction.
   *
   * This is typically used for calculating token sell prices.
   *
   * @param baseToken Token input for the transaction
   * @param quoteToken Output from the transaction
   * @param amount Amount of `baseToken` to put into the transaction
   */
  async estimateSellTrade(
    baseToken: UniswapToken,
    quoteToken: UniswapToken,
    amount: BigNumber,
    allowedSlippage?: string
  ): Promise<ExpectedTrade> {
    const nativeTokenAmount: UniswapTokenAmount = new UniswapTokenAmount(
      baseToken,
      amount.toString()
    );
    logger.info(
      `Fetching pair data for ${baseToken.address}-${quoteToken.address}.`
    );

    // TODO: replace fetcher which returns defira-sdk Pair instead of this uniswap-sdk Pair
    const pair: UniswapPair = await UniswapFetcher.fetchPairData(
      quoteToken,
      baseToken,
      this.harmony.provider
    );
    const trades: UniswapTrade[] = UniswapTrade.bestTradeExactIn(
      [pair],
      nativeTokenAmount,
      quoteToken,
      { maxHops: 1 }
    );
    if (!trades || trades.length === 0) {
      throw new UniswapishPriceError(
        `priceSwapIn: no trade pair found for ${baseToken} to ${quoteToken}.`
      );
    }
    logger.info(
      `Best trade for ${baseToken.address}-${quoteToken.address}: ` +
        `${trades[0].executionPrice.toFixed(6)}` +
        `${baseToken.name}.`
    );
    const expectedAmount = trades[0].minimumAmountOut(
      this.getAllowedSlippage(allowedSlippage)
    );
    return { trade: trades[0], expectedAmount };
  }

  /**
   * Given the amount of `baseToken` desired to acquire from a transaction,
   * calculate the amount of `quoteToken` needed for the transaction.
   *
   * This is typically used for calculating token buy prices.
   *
   * @param quoteToken Token input for the transaction
   * @param baseToken Token output from the transaction
   * @param amount Amount of `baseToken` desired from the transaction
   */
  async estimateBuyTrade(
    quoteToken: UniswapToken,
    baseToken: UniswapToken,
    amount: BigNumber,
    allowedSlippage?: string
  ): Promise<ExpectedTrade> {
    const nativeTokenAmount: UniswapTokenAmount = new UniswapTokenAmount(
      baseToken,
      amount.toString()
    );
    logger.info(
      `Fetching pair data for ${quoteToken.address}-${baseToken.address}.`
    );
    const pair: UniswapPair = await UniswapFetcher.fetchPairData(
      quoteToken,
      baseToken,
      this.harmony.provider
    );
    const trades: UniswapTrade[] = UniswapTrade.bestTradeExactOut(
      [pair],
      quoteToken,
      nativeTokenAmount,
      { maxHops: 1 }
    );
    if (!trades || trades.length === 0) {
      throw new UniswapishPriceError(
        `priceSwapOut: no trade pair found for ${quoteToken.address} to ${baseToken.address}.`
      );
    }
    logger.info(
      `Best trade for ${quoteToken.address}-${baseToken.address}: ` +
        `${trades[0].executionPrice.invert().toFixed(6)} ` +
        `${baseToken.name}.`
    );

    const expectedAmount = trades[0].maximumAmountIn(
      this.getAllowedSlippage(allowedSlippage)
    );
    return { trade: trades[0], expectedAmount };
  }

  /**
   * Given a wallet and a defira trade, try to execute it on blockchain.
   *
   * @param wallet Wallet
   * @param trade Expected trade
   * @param gasPrice Base gas price, for pre-EIP1559 transactions
   * @param defiraRouter Router smart contract address
   * @param ttl How long the swap is valid before expiry, in seconds
   * @param abi Router contract ABI
   * @param gasLimit Gas limit
   * @param nonce (Optional) EVM transaction nonce
   * @param maxFeePerGas (Optional) Maximum total fee per gas you want to pay
   * @param maxPriorityFeePerGas (Optional) Maximum tip per gas you want to pay
   */
  async executeTrade(
    wallet: Wallet,
    trade: UniswapTrade,
    gasPrice: number,
    defiraRouter: string,
    ttl: number,
    abi: ContractInterface,
    gasLimit: number,
    nonce?: number,
    maxFeePerGas?: BigNumber,
    maxPriorityFeePerGas?: BigNumber,
    allowedSlippage?: string
  ): Promise<Transaction> {
    const result: SwapParameters = UniswapRouter.swapCallParameters(trade, {
      ttl,
      recipient: wallet.address,
      allowedSlippage: this.getAllowedSlippage(allowedSlippage),
    });

    const contract: Contract = new Contract(defiraRouter, abi, wallet);
    if (nonce === undefined) {
      nonce = await this.harmony.nonceManager.getNonce(wallet.address);
    }
    let tx: ContractTransaction;
    if (maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined) {
      tx = await contract[result.methodName](...result.args, {
        gasLimit: gasLimit.toFixed(0),
        value: result.value,
        nonce: nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } else {
      tx = await contract[result.methodName](...result.args, {
        gasPrice: (gasPrice * 1e9).toFixed(0),
        gasLimit: gasLimit.toFixed(0),
        value: result.value,
        nonce: nonce,
      });
    }

    logger.info(tx);
    await this.harmony.nonceManager.commitNonce(wallet.address, nonce);
    return tx;
  }
}
