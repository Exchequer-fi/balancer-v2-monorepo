import { expect } from 'chai';
import { ethers } from 'hardhat';
import { BigNumber, Contract } from 'ethers';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { toNormalizedWeights } from '@balancer-labs/balancer-js';
import { arrayAdd, BigNumberish, bn, fp, FP_SCALING_FACTOR, arraySub } from '@balancer-labs/v2-helpers/src/numbers';

import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import { MONTH } from '@balancer-labs/v2-helpers/src/time';
import { actionId } from '@balancer-labs/v2-helpers/src/models/misc/actions';

import { random, range } from 'lodash';
import { ProtocolFee } from '@balancer-labs/v2-helpers/src/models/vault/types';
import { ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { calculateBPTSwapFeeAmount } from '@balancer-labs/v2-helpers/src/models/pools/weighted/math';

describe('JoinExitProtocolFees', () => {
  let admin: SignerWithAddress;
  let owner: SignerWithAddress;
  let vault: Vault, feesCollector: Contract, feesProvider: Contract;
  let poolWeights: BigNumber[];
  let math: Contract;

  const POOL_SWAP_FEE_PERCENTAGE = fp(0.1);
  const FEE_RELATIVE_ERROR = 0.02;
  const MAX_TOKENS = 8;

  const WEIGHTS = range(10000, 10000 + MAX_TOKENS);

  sharedBeforeEach('setup signers', async () => {
    [, admin, owner] = await ethers.getSigners();
  });

  sharedBeforeEach('deploy vault', async () => {
    vault = await Vault.create({ admin });
    feesCollector = await vault.getFeesCollector();
    feesProvider = vault.getFeesProvider();
  });

  sharedBeforeEach('deploy math', async () => {
    math = await deploy('MockWeightedMath');
  });

  sharedBeforeEach('grant permissions to admin', async () => {
    await vault.authorizer
      .connect(admin)
      .grantPermissions([actionId(feesProvider, 'setFeeTypePercentage')], admin.address, [feesProvider.address]);

    await vault.authorizer
      .connect(admin)
      .grantPermissions(
        [actionId(feesCollector, 'setSwapFeePercentage'), actionId(feesCollector, 'setFlashLoanFeePercentage')],
        feesProvider.address,
        [feesCollector.address, feesCollector.address]
      );
  });

  for (let numTokens = 2; numTokens <= MAX_TOKENS; numTokens++) {
    context(`for a ${numTokens} token pool`, () => {
      itBehavesAsWeightedPoolProtocolFees(numTokens);
    });
  }

  function itBehavesAsWeightedPoolProtocolFees(numberOfTokens: number): void {
    describe('protocol fees on join/exit', () => {
      // We want relatively large values to make the fees much larger than rounding error
      const SWAP_PROTOCOL_FEE_PERCENTAGE = fp(0.5);

      const MIN_POOL_TOKEN_BALANCE = 150e6;
      const MAX_POOL_TOKEN_BALANCE = 200e6;

      let pool: Contract, tokens: TokenList;
      let preBalances: BigNumber[];
      let balanceDeltas: BigNumber[];
      let preInvariant: BigNumber;
      let postInvariant: BigNumber;
      let preSupply: BigNumber;
      let currentSupply: BigNumber;

      sharedBeforeEach('deploy tokens', async () => {
        tokens = await TokenList.create(numberOfTokens, { sorted: true });
      });

      sharedBeforeEach('deploy pool', async () => {
        pool = await deploy('MockWeightedPoolProtocolFees', {
          args: [
            vault.address,
            feesProvider.address,
            'Test WP',
            'TWP',
            tokens.addresses,
            tokens.map(() => ZERO_ADDRESS), // rate providers
            tokens.map(() => ZERO_ADDRESS), // asset managers
            POOL_SWAP_FEE_PERCENTAGE,
            MONTH * 3, // pause window
            MONTH, // buffer period
            owner.address,
          ],
        });

        // Set weights
        poolWeights = toNormalizedWeights(WEIGHTS.slice(0, numberOfTokens).map((w) => bn(w)));
      });

      function setProtocolFees(swapFee: BigNumberish) {
        sharedBeforeEach('set protocol fees', async () => {
          await feesProvider.connect(admin).setFeeTypePercentage(ProtocolFee.SWAP, swapFee);

          await pool.updateProtocolFeePercentageCache();
        });
      }

      sharedBeforeEach('setup previous pool state', async () => {
        // Since we're passing the balances directly to the contract, we don't need to worry about scaling factors, and
        // can work with 18 decimal balances directly.
        preBalances = tokens.map(() => fp(random(MIN_POOL_TOKEN_BALANCE, MAX_POOL_TOKEN_BALANCE)));
        balanceDeltas = tokens.map(() => fp(random(0, MIN_POOL_TOKEN_BALANCE / 100)));

        preInvariant = await math.invariant(poolWeights, preBalances);

        // The supply is some factor of the invariant
        preSupply = preInvariant.mul(fp(random(1.5, 10))).div(FP_SCALING_FACTOR);
      });

      describe('getJoinExitProtocolFees', () => {
        context('when the protocol swap fee percentage is zero', () => {
          itPaysProtocolFeesOnJoinExitSwaps(bn(0));
        });

        context('when the protocol swap fee percentage is non-zero', () => {
          itPaysProtocolFeesOnJoinExitSwaps(SWAP_PROTOCOL_FEE_PERCENTAGE);
        });

        function itPaysProtocolFeesOnJoinExitSwaps(swapFee: BigNumber) {
          enum Operation {
            JOIN,
            EXIT,
          }

          setProtocolFees(swapFee);

          context('on proportional join', () => {
            prepareProportionalJoinOrExit(Operation.JOIN);

            itReturnsZeroProtocolFees();

            itUpdatesThePostJoinInvariant();
          });

          context('on proportional exit', () => {
            prepareProportionalJoinOrExit(Operation.EXIT);

            itReturnsZeroProtocolFees();

            itUpdatesThePostJoinInvariant();
          });

          context('on non-proportional join', () => {
            prepareMultiTokenNonProportionalJoinOrExit(Operation.JOIN);

            if (swapFee.eq(0)) {
              itReturnsZeroProtocolFees();
            } else {
              itReturnsTheExpectedProtocolFees();
            }

            itUpdatesThePostJoinInvariant();
          });

          context('on non-proportional exit', () => {
            prepareMultiTokenNonProportionalJoinOrExit(Operation.EXIT);

            if (swapFee.eq(0)) {
              itReturnsZeroProtocolFees();
            } else {
              itReturnsTheExpectedProtocolFees();
            }

            itUpdatesThePostJoinInvariant();
          });

          // This is an exact tokens in/out that happens to be proportional
          function prepareProportionalJoinOrExit(op: Operation) {
            sharedBeforeEach(async () => {
              const ratio = fp(random(0.1, 0.9));

              // Generate amounts for a proportional join/exit
              balanceDeltas = preBalances.map((balance) => balance.mul(ratio).div(fp(1)));

              // increase/decrease the virtual proportionally
              if (op == Operation.JOIN) {
                currentSupply = preSupply.mul(fp(1).add(ratio)).div(fp(1));
              } else {
                currentSupply = preSupply.mul(fp(1).sub(ratio)).div(fp(1));
              }

              const currentBalances =
                op == Operation.JOIN ? arrayAdd(preBalances, balanceDeltas) : arraySub(preBalances, balanceDeltas);

              postInvariant = await math.invariant(poolWeights, currentBalances);
            });
          }

          function prepareMultiTokenNonProportionalJoinOrExit(op: Operation) {
            sharedBeforeEach(async () => {
              const ratio = fp(random(0.1, 0.9));

              // Generate amounts for a proportional join/exit
              const proportionalAmounts = preBalances.map((balance) => balance.mul(ratio).div(fp(1)));

              // Compute deltas that are going to modify the proportional amounts. These will be swap fees.
              const deltas = proportionalAmounts.map((amount) => fp(random(0.05, 0.1)).mul(amount).div(fp(1)));
              let currentBalances: BigNumber[];

              // Compute the balances with the added deltas, and the supply without taking them into account
              // (because they are fees).
              if (op == Operation.JOIN) {
                const proportionalBalances = arrayAdd(preBalances, proportionalAmounts);
                currentSupply = preSupply.mul(fp(1).add(ratio)).div(fp(1));

                currentBalances = arrayAdd(proportionalBalances, deltas);
                balanceDeltas = arraySub(currentBalances, preBalances);
              } else {
                const proportionalBalances = arraySub(preBalances, proportionalAmounts);
                currentSupply = preSupply.mul(fp(1).sub(ratio)).div(fp(1));

                currentBalances = arrayAdd(proportionalBalances, deltas);
                balanceDeltas = arraySub(preBalances, currentBalances);
              }

              postInvariant = await math.invariant(poolWeights, currentBalances);
            });
          }

          function itReturnsZeroProtocolFees() {
            it('returns no (or negligible) BPT', async () => {
              const protocolFeeAmount = await pool.callStatic.getJoinExitProtocolFees(
                preBalances,
                balanceDeltas,
                poolWeights,
                preSupply,
                currentSupply
              );

              // If the protocol swap fee percentage is non-zero, we can't quite guarantee that there'll be zero
              // protocol fees since there's some rounding error in the computation of the currentInvariant the Pool
              // will make, which might result in negligible fees.

              // The BPT amount to mint is computed as a percentage of the current supply. This is done with precision
              // of up to 18 decimal places, so any error below that is always considered negligible. We test for
              // precision of up to 17 decimal places to give some leeway and account for e.g. different rounding
              // directions, etc.
              expect(protocolFeeAmount).to.be.lte(currentSupply.div(bn(1e17)));
            });
          }

          function itReturnsTheExpectedProtocolFees() {
            it('returns the expected protocol fees', async () => {
              const protocolFeeAmount = await pool.callStatic.getJoinExitProtocolFees(
                preBalances,
                balanceDeltas,
                poolWeights,
                preSupply,
                currentSupply
              );

              const invariantGrowthRatio = postInvariant.mul(fp(1)).div(preInvariant);
              const expectedBptAmount = calculateBPTSwapFeeAmount(
                invariantGrowthRatio,
                preSupply,
                currentSupply,
                SWAP_PROTOCOL_FEE_PERCENTAGE
              );

              expect(protocolFeeAmount).to.be.almostEqual(expectedBptAmount, FEE_RELATIVE_ERROR);
            });
          }

          function itUpdatesThePostJoinInvariant() {
            it('updates the postJoin invariant', async () => {
              // _lastPostJoinExitInvariant is expected to be uninitialised.
              expect(await pool.getLastPostJoinExitInvariant()).to.be.eq(0);

              await pool.getJoinExitProtocolFees(preBalances, balanceDeltas, poolWeights, preSupply, currentSupply);

              expect(await pool.getLastPostJoinExitInvariant()).to.almostEqual(postInvariant);
            });
          }
        }
      });
    });
  }
});
