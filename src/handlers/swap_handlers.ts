// tslint:disable:max-file-line-count
import { RfqtRequestOpts, SwapQuoterError } from '@0x/asset-swapper';
import { MarketOperation } from '@0x/types';
import { BigNumber, NULL_ADDRESS } from '@0x/utils';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import _ = require('lodash');
import { Counter } from 'prom-client';

import { CHAIN_ID, PLP_API_KEY_WHITELIST, RFQT_API_KEY_WHITELIST, RFQT_REGISTRY_PASSWORDS } from '../config';
import {
    DEFAULT_QUOTE_SLIPPAGE_PERCENTAGE,
    MARKET_DEPTH_DEFAULT_DISTRIBUTION,
    MARKET_DEPTH_MAX_SAMPLES,
    SWAP_DOCS_URL,
} from '../constants';
import {
    InternalServerError,
    RevertAPIError,
    ValidationError,
    ValidationErrorCodes,
    ValidationErrorReasons,
} from '../errors';
import { logger } from '../logger';
import { isAPIError, isRevertError } from '../middleware/error_handling';
import { schemas } from '../schemas/schemas';
import { SwapService } from '../services/swap_service';
import { TokenMetadatasForChains } from '../token_metadatas_for_networks';
import {
    CalculateSwapQuoteParams,
    GetSwapPriceResponse,
    GetSwapQuoteRequestParams,
    GetSwapQuoteResponse,
} from '../types';
import { parseUtils } from '../utils/parse_utils';
import { priceComparisonUtils } from '../utils/price_comparison_utils';
import { schemaUtils } from '../utils/schema_utils';
import { serviceUtils } from '../utils/service_utils';
import {
    findTokenAddressOrThrow,
    findTokenAddressOrThrowApiError,
    getTokenMetadataIfExists,
    isETHSymbolOrAddress,
    isWETHSymbolOrAddress,
} from '../utils/token_metadata_utils';

import { quoteReportUtils } from './../utils/quote_report_utils';

const BEARER_REGEX = /^Bearer\s(.{36})$/;
const REGISTRY_SET: Set<string> = new Set(RFQT_REGISTRY_PASSWORDS);
const REGISTRY_ENDPOINT_FETCHED = new Counter({
    name: 'swap_handler_registry_endpoint_fetched',
    help: 'Requests to the swap handler',
    labelNames: ['identifier'],
});

export class SwapHandlers {
    private readonly _swapService: SwapService;
    public static rootAsync(_req: express.Request, res: express.Response): void {
        const message = `This is the root of the Swap API. Visit ${SWAP_DOCS_URL} for details about this API.`;
        res.status(HttpStatus.OK).send({ message });
    }

    public static async getRfqRegistryAsync(req: express.Request, res: express.Response): Promise<void> {
        const auth = req.header('Authorization');
        REGISTRY_ENDPOINT_FETCHED.labels(auth || 'N/A').inc();
        if (auth === undefined) {
            return res.status(HttpStatus.UNAUTHORIZED).end();
        }
        const authTokenRegex = auth.match(BEARER_REGEX);
        if (!authTokenRegex) {
            return res.status(HttpStatus.UNAUTHORIZED).end();
        }
        const authToken = authTokenRegex[1];
        if (!REGISTRY_SET.has(authToken)) {
            return res.status(HttpStatus.UNAUTHORIZED).end();
        }
        res.status(HttpStatus.OK)
            .send(RFQT_API_KEY_WHITELIST)
            .end();
    }
    constructor(swapService: SwapService) {
        this._swapService = swapService;
    }

    public async getSwapQuoteAsync(req: express.Request, res: express.Response): Promise<void> {
        const params = parseGetSwapQuoteRequestParams(req, 'quote');
        const quote = await this._calculateSwapQuoteAsync(params);
        if (params.rfqt !== undefined) {
            logger.info({
                firmQuoteServed: {
                    taker: params.takerAddress,
                    apiKey: params.apiKey,
                    buyToken: params.buyToken,
                    sellToken: params.sellToken,
                    buyAmount: params.buyAmount,
                    sellAmount: params.sellAmount,
                    makers: quote.orders.map(order => order.makerAddress),
                },
            });
            if (quote.quoteReport && params.rfqt && params.rfqt.intentOnFilling) {
                quoteReportUtils.logQuoteReport({
                    quoteReport: quote.quoteReport,
                    submissionBy: 'taker',
                    decodedUniqueId: quote.decodedUniqueId,
                    buyTokenAddress: quote.buyTokenAddress,
                    sellTokenAddress: quote.sellTokenAddress,
                    buyAmount: params.buyAmount,
                    sellAmount: params.sellAmount,
                });
            }
        }
        const response = _.omit(quote, 'quoteReport', 'decodedUniqueId');
        const { quoteReport } = quote;
        if (params.includePriceComparisons && quoteReport) {
            const side = params.sellAmount ? MarketOperation.Sell : MarketOperation.Buy;
            const priceComparisons = priceComparisonUtils.getPriceComparisonFromQuote(CHAIN_ID, side, quote);
            response.priceComparisons = priceComparisons?.map(sc => priceComparisonUtils.renameNative(sc));
        }
        res.status(HttpStatus.OK).send(response);
    }
    // tslint:disable-next-line:prefer-function-over-method
    public async getSwapTokensAsync(_req: express.Request, res: express.Response): Promise<void> {
        const tokens = TokenMetadatasForChains.map(tm => ({
            symbol: tm.symbol,
            address: tm.tokenAddresses[CHAIN_ID],
            name: tm.name,
            decimals: tm.decimals,
        }));
        const filteredTokens = tokens.filter(t => t.address !== NULL_ADDRESS);
        res.status(HttpStatus.OK).send({ records: filteredTokens });
    }
    // tslint:disable-next-line:prefer-function-over-method
    public async getSwapPriceAsync(req: express.Request, res: express.Response): Promise<void> {
        const params = parseGetSwapQuoteRequestParams(req, 'price');
        const quote = await this._calculateSwapQuoteAsync({ ...params, skipValidation: true });
        logger.info({
            indicativeQuoteServed: {
                taker: params.takerAddress,
                apiKey: params.apiKey,
                buyToken: params.buyToken,
                sellToken: params.sellToken,
                buyAmount: params.buyAmount,
                sellAmount: params.sellAmount,
                makers: quote.orders.map(o => o.makerAddress),
            },
        });

        const response: GetSwapPriceResponse = _.pick(
            quote,
            'price',
            'value',
            'gasPrice',
            'gas',
            'estimatedGas',
            'protocolFee',
            'minimumProtocolFee',
            'buyTokenAddress',
            'buyAmount',
            'sellTokenAddress',
            'sellAmount',
            'sources',
            'allowanceTarget',
            'sellTokenToEthRate',
            'buyTokenToEthRate',
        );
        const { quoteReport } = quote;
        if (params.includePriceComparisons && quoteReport) {
            const marketSide = params.sellAmount ? MarketOperation.Sell : MarketOperation.Buy;
            response.priceComparisons = priceComparisonUtils
                .getPriceComparisonFromQuote(CHAIN_ID, marketSide, quote)
                ?.map(sc => priceComparisonUtils.renameNative(sc));
        }
        res.status(HttpStatus.OK).send(quote);
    }
    // tslint:disable-next-line:prefer-function-over-method
    public async getTokenPricesAsync(req: express.Request, res: express.Response): Promise<void> {
        const symbolOrAddress = (req.query.sellToken as string) || 'WETH';
        const baseAsset = getTokenMetadataIfExists(symbolOrAddress, CHAIN_ID);
        if (!baseAsset) {
            throw new ValidationError([
                {
                    field: 'sellToken',
                    code: ValidationErrorCodes.ValueOutOfRange,
                    reason: `Could not find token ${symbolOrAddress}`,
                },
            ]);
        }
        const unitAmount = new BigNumber(1);
        const records = await this._swapService.getTokenPricesAsync(baseAsset, unitAmount);
        res.status(HttpStatus.OK).send({ records });
    }

    public async getMarketDepthAsync(req: express.Request, res: express.Response): Promise<void> {
        // NOTE: Internally all ETH trades are for WETH, we just wrap/unwrap automatically
        const buyTokenSymbolOrAddress = isETHSymbolOrAddress(req.query.buyToken as string)
            ? 'WETH'
            : (req.query.buyToken as string);
        const sellTokenSymbolOrAddress = isETHSymbolOrAddress(req.query.sellToken as string)
            ? 'WETH'
            : (req.query.sellToken as string);

        if (buyTokenSymbolOrAddress === sellTokenSymbolOrAddress) {
            throw new ValidationError([
                {
                    field: 'buyToken',
                    code: ValidationErrorCodes.InvalidAddress,
                    reason: `Invalid pair ${sellTokenSymbolOrAddress}/${buyTokenSymbolOrAddress}`,
                },
            ]);
        }
        const response = await this._swapService.calculateMarketDepthAsync({
            buyToken: findTokenAddressOrThrow(buyTokenSymbolOrAddress, CHAIN_ID),
            sellToken: findTokenAddressOrThrow(sellTokenSymbolOrAddress, CHAIN_ID),
            sellAmount: new BigNumber(req.query.sellAmount as string),
            // tslint:disable-next-line:radix custom-no-magic-numbers
            numSamples: req.query.numSamples ? parseInt(req.query.numSamples as string) : MARKET_DEPTH_MAX_SAMPLES,
            sampleDistributionBase: req.query.sampleDistributionBase
                ? parseFloat(req.query.sampleDistributionBase as string)
                : MARKET_DEPTH_DEFAULT_DISTRIBUTION,
            excludedSources:
                req.query.excludedSources === undefined
                    ? []
                    : parseUtils.parseStringArrForERC20BridgeSources((req.query.excludedSources as string).split(',')),
            includedSources:
                req.query.includedSources === undefined
                    ? []
                    : parseUtils.parseStringArrForERC20BridgeSources((req.query.includedSources as string).split(',')),
        });
        res.status(HttpStatus.OK).send(response);
    }

    private async _calculateSwapQuoteAsync(params: GetSwapQuoteRequestParams): Promise<GetSwapQuoteResponse> {
        const {
            sellToken,
            buyToken,
            sellAmount,
            buyAmount,
            takerAddress,
            slippagePercentage,
            gasPrice,
            excludedSources,
            includedSources,
            affiliateAddress,
            rfqt,
            // tslint:disable-next-line:boolean-naming
            skipValidation,
            apiKey,
            affiliateFee,
            // tslint:disable-next-line:boolean-naming
            includePriceComparisons,
            shouldSellEntireBalance,
        } = params;

        const isETHSell = isETHSymbolOrAddress(sellToken);
        const isETHBuy = isETHSymbolOrAddress(buyToken);
        // NOTE: Internally all ETH trades are for WETH, we just wrap/unwrap automatically
        const sellTokenAddress = findTokenAddressOrThrowApiError(isETHSell ? 'WETH' : sellToken, 'sellToken', CHAIN_ID);
        const buyTokenAddress = findTokenAddressOrThrowApiError(isETHBuy ? 'WETH' : buyToken, 'buyToken', CHAIN_ID);
        const isWrap = isETHSell && isWETHSymbolOrAddress(buyToken, CHAIN_ID);
        const isUnwrap = isWETHSymbolOrAddress(sellToken, CHAIN_ID) && isETHBuy;
        // if token addresses are the same but a unwrap or wrap operation is requested, ignore error
        if (!isUnwrap && !isWrap && sellTokenAddress === buyTokenAddress) {
            throw new ValidationError(
                ['buyToken', 'sellToken'].map(field => {
                    return {
                        field,
                        code: ValidationErrorCodes.RequiredField,
                        reason: 'buyToken and sellToken must be different',
                    };
                }),
            );
        }

        const calculateSwapQuoteParams: CalculateSwapQuoteParams = {
            buyTokenAddress,
            sellTokenAddress,
            buyAmount,
            sellAmount,
            from: takerAddress,
            isETHSell,
            isETHBuy,
            slippagePercentage,
            gasPrice,
            excludedSources,
            includedSources,
            affiliateAddress,
            apiKey,
            rfqt:
                rfqt === undefined
                    ? undefined
                    : {
                          intentOnFilling: rfqt.intentOnFilling,
                          isIndicative: rfqt.isIndicative,
                          nativeExclusivelyRFQT: rfqt.nativeExclusivelyRFQT,
                      },
            skipValidation,
            affiliateFee,
            isMetaTransaction: false,
            includePriceComparisons,
            shouldSellEntireBalance,
        };
        try {
            let swapQuote: GetSwapQuoteResponse;
            if (isUnwrap) {
                swapQuote = await this._swapService.getSwapQuoteForUnwrapAsync(calculateSwapQuoteParams);
            } else if (isWrap) {
                swapQuote = await this._swapService.getSwapQuoteForWrapAsync(calculateSwapQuoteParams);
            } else {
                swapQuote = await this._swapService.calculateSwapQuoteAsync(calculateSwapQuoteParams);
            }
            return swapQuote;
        } catch (e) {
            // If this is already a transformed error then just re-throw
            if (isAPIError(e)) {
                throw e;
            }
            // Wrap a Revert error as an API revert error
            if (isRevertError(e)) {
                throw new RevertAPIError(e);
            }
            const errorMessage: string = e.message;
            // TODO AssetSwapper can throw raw Errors or InsufficientAssetLiquidityError
            if (
                errorMessage.startsWith(SwapQuoterError.InsufficientAssetLiquidity) ||
                errorMessage.startsWith('NO_OPTIMAL_PATH')
            ) {
                throw new ValidationError([
                    {
                        field: buyAmount ? 'buyAmount' : 'sellAmount',
                        code: ValidationErrorCodes.ValueOutOfRange,
                        reason: SwapQuoterError.InsufficientAssetLiquidity,
                    },
                ]);
            }
            if (errorMessage.startsWith(SwapQuoterError.AssetUnavailable)) {
                throw new ValidationError([
                    {
                        field: 'token',
                        code: ValidationErrorCodes.ValueOutOfRange,
                        reason: e.message,
                    },
                ]);
            }
            logger.info('Uncaught error', e.message, e.stack);
            throw new InternalServerError(e.message);
        }
    }
}

const parseGetSwapQuoteRequestParams = (
    req: express.Request,
    endpoint: 'price' | 'quote',
): GetSwapQuoteRequestParams => {
    // HACK typescript typing does not allow this valid json-schema
    schemaUtils.validateSchema(req.query, schemas.swapQuoteRequestSchema as any);
    const takerAddress = req.query.takerAddress as string;
    const sellToken = req.query.sellToken as string;
    const buyToken = req.query.buyToken as string;
    const sellAmount = req.query.sellAmount === undefined ? undefined : new BigNumber(req.query.sellAmount as string);
    const buyAmount = req.query.buyAmount === undefined ? undefined : new BigNumber(req.query.buyAmount as string);
    const gasPrice = req.query.gasPrice === undefined ? undefined : new BigNumber(req.query.gasPrice as string);
    const slippagePercentage =
        Number.parseFloat(req.query.slippagePercentage as string) || DEFAULT_QUOTE_SLIPPAGE_PERCENTAGE;
    if (slippagePercentage > 1) {
        throw new ValidationError([
            {
                field: 'slippagePercentage',
                code: ValidationErrorCodes.ValueOutOfRange,
                reason: ValidationErrorReasons.PercentageOutOfRange,
            },
        ]);
    }

    const feeRecipient = req.query.feeRecipient as string;
    const sellTokenPercentageFee = Number.parseFloat(req.query.sellTokenPercentageFee as string) || 0;
    const buyTokenPercentageFee = Number.parseFloat(req.query.buyTokenPercentageFee as string) || 0;
    if (sellTokenPercentageFee > 0) {
        throw new ValidationError([
            {
                field: 'sellTokenPercentageFee',
                code: ValidationErrorCodes.UnsupportedOption,
                reason: ValidationErrorReasons.ArgumentNotYetSupported,
            },
        ]);
    }
    if (buyTokenPercentageFee > 1) {
        throw new ValidationError([
            {
                field: 'buyTokenPercentageFee',
                code: ValidationErrorCodes.ValueOutOfRange,
                reason: ValidationErrorReasons.PercentageOutOfRange,
            },
        ]);
    }
    const affiliateFee = feeRecipient
        ? {
              recipient: feeRecipient,
              sellTokenPercentageFee,
              buyTokenPercentageFee,
          }
        : {
              recipient: NULL_ADDRESS,
              sellTokenPercentageFee: 0,
              buyTokenPercentageFee: 0,
          };

    const apiKey: string | undefined = req.header('0x-api-key');
    // tslint:disable-next-line: boolean-naming
    const { excludedSources, includedSources, nativeExclusivelyRFQT } = parseUtils.parseRequestForExcludedSources(
        {
            excludedSources: req.query.excludedSources as string | undefined,
            includedSources: req.query.includedSources as string | undefined,
            intentOnFilling: req.query.intentOnFilling as string | undefined,
            takerAddress,
            apiKey,
        },
        RFQT_API_KEY_WHITELIST,
        endpoint,
    );

    // Determine if any other sources should be excluded. This usually has an effect
    // if an API key is not present, or the API key is ineligible for PLP.
    const updatedExcludedSources = serviceUtils.determineExcludedSources(
        excludedSources,
        apiKey,
        PLP_API_KEY_WHITELIST,
    );

    logger.info({
        type: 'swapRequest',
        endpoint,
        updatedExcludedSources,
        nativeExclusivelyRFQT,
        apiKey: apiKey || 'N/A',
    });

    const affiliateAddress = req.query.affiliateAddress as string | undefined;
    const rfqt:
        | Pick<RfqtRequestOpts, 'intentOnFilling' | 'isIndicative' | 'nativeExclusivelyRFQT'>
        | undefined = (() => {
        if (apiKey) {
            if (endpoint === 'quote' && takerAddress) {
                return {
                    intentOnFilling: req.query.intentOnFilling === 'true',
                    isIndicative: false,
                    nativeExclusivelyRFQT,
                };
            } else if (endpoint === 'price') {
                return {
                    intentOnFilling: false,
                    isIndicative: true,
                    nativeExclusivelyRFQT,
                };
            }
        }
        return undefined;
    })();
    // tslint:disable-next-line:boolean-naming
    const skipValidation = req.query.skipValidation === undefined ? false : req.query.skipValidation === 'true';

    // tslint:disable-next-line:boolean-naming
    const includePriceComparisons = req.query.includePriceComparisons === 'true' ? true : false;
    // Whether the entire callers balance should be sold, used for contracts where the
    // amount available is non-deterministic
    const shouldSellEntireBalance = req.query.shouldSellEntireBalance === 'true' ? true : false;
    return {
        takerAddress,
        sellToken,
        buyToken,
        sellAmount,
        buyAmount,
        slippagePercentage,
        gasPrice,
        excludedSources: updatedExcludedSources,
        includedSources,
        affiliateAddress,
        rfqt,
        skipValidation,
        apiKey,
        affiliateFee,
        includePriceComparisons,
        shouldSellEntireBalance,
    };
};
