import { expect } from 'chai';
import { BigNumber, Contract } from 'ethers';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { fp } from '@balancer-labs/v2-helpers/src/numbers';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import { ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { random, range } from 'lodash';
import { toNormalizedWeights } from '@balancer-labs/balancer-js';
import { calculateInvariant } from '@balancer-labs/v2-helpers/src/models/pools/weighted/math';
import { actionId } from '@balancer-labs/v2-helpers/src/models/misc/actions';
import { ProtocolFee } from '@balancer-labs/v2-helpers/src/models/vault/types';
import TypesConverter from '@balancer-labs/v2-helpers/src/models/types/TypesConverter';

const randomFloat = (min: number, max: number) => random(min, max, true);

describe('WeightedPoolProtocolFees (Yield)', () => {
  let vault: Vault;
  let pool: Contract;
  let rateProviders: (Contract | string)[];

  const NAME = 'Balancer Pool Token';
  const SYMBOL = 'BPT';
  const POOL_SWAP_FEE_PERCENTAGE = fp(0.01);
  const PROTOCOL_YIELD_FEE_PERCENTAGE = fp(0.5);

  before('deploy lib', async () => {
    vault = await Vault.create();

    if (!vault.admin) throw new Error('Vault has no admin');
    const protocolFeesProvider = vault.protocolFeesProvider;
    const action = await actionId(protocolFeesProvider, 'setFeeTypePercentage');
    await vault.grantPermissionsGlobally([action], vault.admin);
    await protocolFeesProvider
      .connect(vault.admin)
      .setFeeTypePercentage(ProtocolFee.YIELD, PROTOCOL_YIELD_FEE_PERCENTAGE);
  });

  async function deployPool(numTokens: number, { payYieldFees } = { payYieldFees: true }) {
    const tokens = await TokenList.create(numTokens, { sorted: true });
    if (payYieldFees) {
      rateProviders = await tokens.asyncMap(async () => await deploy('v2-pool-utils/MockRateProvider'));
    } else {
      rateProviders = await tokens.asyncMap(async () => ZERO_ADDRESS);
    }

    pool = await deploy('MockWeightedPoolProtocolFees', {
      args: [
        vault.address,
        vault.protocolFeesProvider.address,
        NAME,
        SYMBOL,
        tokens.addresses,
        TypesConverter.toAddresses(rateProviders),
        tokens.map(() => ZERO_ADDRESS),
        POOL_SWAP_FEE_PERCENTAGE,
        0,
        0,
        ZERO_ADDRESS,
      ],
    });
  }

  for (let numTokens = 2; numTokens <= 8; numTokens++) {
    describe(`for a ${numTokens} token pool`, () => {
      sharedBeforeEach('deploy pool', async () => {
        await deployPool(numTokens);
      });

      describe('constructor', () => {
        it('sets the rate providers', async () => {
          const rateProviderAddresses = TypesConverter.toAddresses(rateProviders);
          const providers = await pool.getRateProviders();

          expect(providers).to.deep.eq(rateProviderAddresses);
        });
      });

      describe('getRateProduct', () => {
        let rates: BigNumber[];

        sharedBeforeEach(async () => {
          rates = rateProviders.map(() => fp(randomFloat(1, 5)));

          for (const [index, provider] of rateProviders.entries()) {
            if (typeof provider !== 'string') await provider.mockRate(rates[index]);
          }
        });

        it("returns the weighted product of the tokens' rates", async () => {
          const normalizedWeights = toNormalizedWeights(range(numTokens).map(() => fp(random(1, 5))));
          const expectedRateProduct = calculateInvariant(rates, normalizedWeights);

          const rateProduct = await pool.getRateProduct(normalizedWeights);
          expect(rateProduct).to.be.almostEqual(expectedRateProduct, 0.0001);
        });
      });

      describe('getYieldProtocolFee', () => {
        let normalizedWeights: BigNumber[];
        sharedBeforeEach('choose weights', async () => {
          normalizedWeights = toNormalizedWeights(rateProviders.map(() => fp(random(1, 5))));
        });

        context('when pool pays fees on yield', () => {
          context('when first called', () => {
            sharedBeforeEach('check athRateProduct is uninitialized', async () => {
              expect(await pool.getATHRateProduct()).to.be.eq(0);
            });

            it('initializes athRateProduct', async () => {
              await pool.getYieldProtocolFee(normalizedWeights, fp(1));

              // All rate providers return 1 by default so the product is 1.
              const expectedRateProduct = fp(1);
              expect(await pool.getATHRateProduct()).to.be.almostEqual(expectedRateProduct, 0.0001);
            });

            it('returns zero', async () => {
              const protocolFees = await pool.callStatic.getYieldProtocolFee(normalizedWeights, fp(1));

              expect(protocolFees).to.be.eq(0);
            });
          });

          context('on subsequent calls', () => {
            sharedBeforeEach('initialize athRateProduct', async () => {
              await pool.getYieldProtocolFee(normalizedWeights, fp(1));
              expect(await pool.getATHRateProduct()).to.be.gt(0);
            });

            context('when rate product has increased', () => {
              let rates: BigNumber[];
              sharedBeforeEach('set rates', async () => {
                rates = rateProviders.map(() => fp(randomFloat(1, 2)));

                for (const [index, provider] of rateProviders.entries()) {
                  if (typeof provider !== 'string') await provider.mockRate(rates[index]);
                }
              });

              it('it updates athRateProduct', async () => {
                await pool.getYieldProtocolFee(normalizedWeights, fp(1));

                const expectedRateProduct = calculateInvariant(rates, normalizedWeights);
                expect(await pool.getATHRateProduct()).to.be.almostEqual(expectedRateProduct, 0.0001);
              });

              it('it returns the expected amount of protocol fees', async () => {
                const athRateProduct = await pool.getATHRateProduct();

                const currentSupply = fp(randomFloat(1, 5));
                const protocolFees = await pool.callStatic.getYieldProtocolFee(normalizedWeights, currentSupply);

                const rateProductGrowth = calculateInvariant(rates, normalizedWeights).mul(fp(1)).div(athRateProduct);
                const yieldPercentage = fp(1).sub(fp(1).mul(fp(1)).div(rateProductGrowth));
                const protocolYieldFeesPercentage = yieldPercentage.mul(PROTOCOL_YIELD_FEE_PERCENTAGE).div(fp(1));

                const expectedProtocolFees = currentSupply
                  .mul(protocolYieldFeesPercentage)
                  .div(fp(1).sub(protocolYieldFeesPercentage));
                expect(protocolFees).to.be.almostEqual(expectedProtocolFees, 0.0001);
              });
            });

            context('when rate product has decreased', () => {
              let rates: BigNumber[];
              sharedBeforeEach('set rates', async () => {
                rates = rateProviders.map(() => fp(random(0.5, 1)));

                for (const [index, provider] of rateProviders.entries()) {
                  if (typeof provider !== 'string') await provider.mockRate(rates[index]);
                }
              });

              it("it doesn't change athRateProduct", async () => {
                const expectedATHRateProduct = await pool.getATHRateProduct();
                await pool.getYieldProtocolFee(normalizedWeights, fp(1));

                expect(await pool.getATHRateProduct()).to.be.eq(expectedATHRateProduct);
              });

              it('it returns zero', async () => {
                const protocolFees = await pool.callStatic.getYieldProtocolFee(normalizedWeights, fp(1));

                expect(protocolFees).to.be.eq(0);
              });
            });
          });
        });

        context('when pool does not pay fees on yield', () => {
          sharedBeforeEach('deploy fee-exempt pool', async () => {
            await deployPool(numTokens, { payYieldFees: false });
          });

          function itSkipsFeeLogic() {
            it('does not initialize athRateProduct', async () => {
              await pool.getYieldProtocolFee(normalizedWeights, fp(1));

              expect(await pool.getATHRateProduct()).to.be.eq(0);
            });

            it('returns zero', async () => {
              const protocolFees = await pool.callStatic.getYieldProtocolFee(normalizedWeights, fp(1));

              expect(protocolFees).to.be.eq(0);
            });
          }

          context('when first called', () => {
            sharedBeforeEach('check athRateProduct is uninitialized', async () => {
              expect(await pool.getATHRateProduct()).to.be.eq(0);
            });

            itSkipsFeeLogic();
          });

          context('on subsequent calls', () => {
            sharedBeforeEach('perform initialisation step', async () => {
              // The first call to `getYieldProtocolFee` would usually initialise the fee logic.
              // This is not the case for fee-exempt pools but we do it to check subsequent calls happen correctly.
              await pool.getYieldProtocolFee(normalizedWeights, fp(1));
            });

            itSkipsFeeLogic();
          });
        });
      });
    });
  }
});
