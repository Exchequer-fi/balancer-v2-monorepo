import { Contract } from 'ethers';

import { bn, fp, FP_SCALING_FACTOR } from '@balancer-labs/v2-helpers/src/numbers';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';
import {
  calculateInvariant,
  calculateBPTSwapFeeAmount,
} from '@balancer-labs/v2-helpers/src/models/pools/weighted/math';
import { expect } from 'chai';

const MAX_RELATIVE_ERROR = 0.0001; // Max relative error

describe('InvariantGrowthProtocolSwapFees', function () {
  let mock: Contract;

  sharedBeforeEach(async function () {
    mock = await deploy('MockInvariantGrowthProtocolSwapFees');
  });

  context('with invariant growth', () => {
    it('returns protocol swap fees', async () => {
      const normalizedWeights = [bn(0.3e18), bn(0.7e18)];
      const lastBalances = [bn(25e18), bn(500e18)];

      // Both balances increase by 40%
      const currentBalances = [bn(35e18), bn(700e18)];

      const protocolSwapFeePercentage = fp(0.3);
      // The protocol is due 30% of the 10 extra tokens in token A (3 tokens), and 30% of the 200 extra tokens in token B
      // (60 tokens).

      const totalSupply = fp(100);

      const lastInvariant = calculateInvariant(lastBalances, normalizedWeights);
      const currentInvariant = calculateInvariant(currentBalances, normalizedWeights);

      const toMint = await mock.calculateDueProtocolFees(
        currentInvariant.mul(fp(1)).div(lastInvariant),
        totalSupply,
        totalSupply,
        protocolSwapFeePercentage
      );

      // The BPT to mint should be such that it'd let the protocol claim the tokens it is due if exiting proportionally
      const protocolPoolOwnership = toMint.mul(FP_SCALING_FACTOR).div(totalSupply.add(toMint)); // The BPT supply grows

      const tokenAFeeAmount = currentBalances[0].mul(protocolPoolOwnership).div(FP_SCALING_FACTOR);
      const tokenBFeeAmount = currentBalances[1].mul(protocolPoolOwnership).div(FP_SCALING_FACTOR);

      expectEqualWithError(tokenAFeeAmount, bn(3e18), MAX_RELATIVE_ERROR);
      expectEqualWithError(tokenBFeeAmount, bn(60e18), MAX_RELATIVE_ERROR);

      // The TS helper outputs the same value

      const expectedToMint = calculateBPTSwapFeeAmount(
        currentInvariant.mul(fp(1)).div(lastInvariant),
        totalSupply,
        totalSupply,
        protocolSwapFeePercentage
      );

      expectEqualWithError(toMint, expectedToMint, MAX_RELATIVE_ERROR);
    });
  });

  context('with smaller invariant', () => {
    it('returns zero', async () => {
      const protocolSwapFeePercentage = fp(0.3);
      const totalSupply = fp(100);

      const lastInvariant = fp(300);
      const currentInvariant = fp(299);

      const toMint = await mock.calculateDueProtocolFees(
        currentInvariant.mul(fp(1)).div(lastInvariant),
        totalSupply,
        totalSupply,
        protocolSwapFeePercentage
      );

      expect(toMint).to.equal(0);
    });
  });
});
