// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20RouterMinimal {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ILocalSwapPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function addLiquidity(
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        uint256 deadline
    ) external returns (uint256 shares);
    function quoteExactIn(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut);
    function swapExactIn(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut);
}

/// @title LocalSwapRouter
/// @notice Stateless, atomic exact-input routing across at most four LocalSwap pools.
/// @dev The frontend accepts this router only when its deployed runtime hash matches the bundled artifact.
contract LocalSwapRouter {
    uint256 public constant MAX_HOPS = 4;
    uint256 private unlocked = 1;

    error Expired();
    error InvalidAmount();
    error InvalidPath();
    error InvalidRecipient();
    error SlippageExceeded();
    error TransferFailed();
    error UnsupportedTokenBehavior();
    error Reentrancy();

    event RoutedSwap(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountOut
    );

    event RoutedLiquidity(
        address indexed sender,
        address indexed pool,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 shares
    );

    modifier lock() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    function quoteExactIn(
        address[] calldata pools,
        address tokenIn,
        uint256 amountIn
    ) external view returns (uint256 amountOut, address tokenOut) {
        _validatePathLength(pools.length);
        if (tokenIn == address(0) || amountIn == 0) revert InvalidAmount();
        address[] memory visitedTokens = new address[](pools.length + 1);
        visitedTokens[0] = tokenIn;
        tokenOut = tokenIn;
        amountOut = amountIn;
        for (uint256 i; i < pools.length; ++i) {
            _assertUniquePool(pools, i);
            tokenOut = _nextToken(pools[i], tokenOut);
            _assertUniqueToken(visitedTokens, i + 1, tokenOut);
            visitedTokens[i + 1] = tokenOut;
            amountOut = ILocalSwapPool(pools[i]).quoteExactIn(visitedTokens[i], amountOut);
            if (amountOut == 0) revert InvalidAmount();
        }
    }

    function swapExactIn(
        address[] calldata pools,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external lock returns (uint256 amountOut, address tokenOut) {
        _validatePathLength(pools.length);
        if (block.timestamp > deadline) revert Expired();
        if (tokenIn == address(0) || amountIn == 0 || minAmountOut == 0) revert InvalidAmount();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();

        uint256 inputBefore = IERC20RouterMinimal(tokenIn).balanceOf(address(this));
        _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        if (IERC20RouterMinimal(tokenIn).balanceOf(address(this)) - inputBefore != amountIn) {
            revert UnsupportedTokenBehavior();
        }

        address[] memory visitedTokens = new address[](pools.length + 1);
        visitedTokens[0] = tokenIn;
        tokenOut = tokenIn;
        amountOut = amountIn;

        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            _assertUniquePool(pools, i);
            address currentToken = tokenOut;
            tokenOut = _nextToken(pool, currentToken);
            _assertUniqueToken(visitedTokens, i + 1, tokenOut);
            visitedTokens[i + 1] = tokenOut;
            if (i + 1 == pools.length) {
                amountOut = _executeHop(pool, currentToken, tokenOut, amountOut, minAmountOut, recipient, deadline);
            } else {
                // Bind an intermediate hop to its own quote rather than to zero.
                // Nothing can move the reserves between this read and the swap —
                // both pools and this router hold their locks for the whole call —
                // so an exact bound here can never revert a hop that was going to
                // succeed, and an unbounded hop is never sent.
                uint256 hopMinimum = ILocalSwapPool(pool).quoteExactIn(currentToken, amountOut);
                amountOut = _executeHop(pool, currentToken, tokenOut, amountOut, hopMinimum, address(this), deadline);
            }
        }

        if (amountOut < minAmountOut) revert SlippageExceeded();
        emit RoutedSwap(msg.sender, tokenIn, tokenOut, amountOut);
    }

    function _nextToken(address pool, address tokenIn) private view returns (address tokenOut) {
        if (pool == address(0)) revert InvalidPath();
        address token0 = ILocalSwapPool(pool).token0();
        address token1 = ILocalSwapPool(pool).token1();
        if (token0 == address(0) || token1 == address(0) || token0 == token1) revert InvalidPath();
        if (tokenIn == token0) return token1;
        if (tokenIn == token1) return token0;
        revert InvalidPath();
    }

    function _executeHop(
        address pool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minimumOut,
        address recipient,
        uint256 deadline
    ) private returns (uint256 receivedOut) {
        _safeApprove(tokenIn, pool, 0);
        _safeApprove(tokenIn, pool, amountIn);
        uint256 outputBefore = IERC20RouterMinimal(tokenOut).balanceOf(recipient);
        uint256 returnedOut = ILocalSwapPool(pool).swapExactIn(
            tokenIn,
            amountIn,
            minimumOut,
            recipient,
            deadline
        );
        receivedOut = IERC20RouterMinimal(tokenOut).balanceOf(recipient) - outputBefore;
        if (receivedOut != returnedOut || IERC20RouterMinimal(tokenIn).allowance(address(this), pool) != 0) {
            revert UnsupportedTokenBehavior();
        }
    }

    function _assertUniquePool(address[] calldata pools, uint256 index) private pure {
        for (uint256 i; i < index; ++i) if (pools[i] == pools[index]) revert InvalidPath();
    }

    /// @notice What `addLiquidity` would pull right now, at the current reserves.
    /// @dev The screen has to tell a depositor what the pool will actually take,
    ///      because off-ratio amounts are trimmed. Computing that in the frontend
    ///      means two implementations of one rule, and they drift. This is the same
    ///      settlement the deposit performs, so the number shown comes from the code
    ///      that will run. It is still a quote: reserves move, and the deposit
    ///      settles again against the reserves it actually meets.
    function quoteAddLiquidity(
        address pool,
        uint256 amount0Desired,
        uint256 amount1Desired
    ) external view returns (uint256 amount0, uint256 amount1) {
        if (pool == address(0)) revert InvalidPath();
        if (amount0Desired == 0 || amount1Desired == 0) revert InvalidAmount();
        (uint112 reserve0, uint112 reserve1, ) = ILocalSwapPool(pool).getReserves();
        return _settleRatio(amount0Desired, amount1Desired, reserve0, reserve1);
    }

    /// @notice Deposits into `pool` at the ratio that holds when this call executes.
    /// @dev The pool credits only what its current ratio allows and leaves the rest
    ///      untaken. A caller who approves what they typed is therefore left with an
    ///      allowance standing on the pool for the difference — measured at 300 JADE
    ///      for a 100 / 500 deposit into a 1 : 2 pool. Computing the ratio in the
    ///      frontend does not fix it: reserves move between the read and the mined
    ///      transaction, so the amounts go stale and the residue returns.
    ///
    ///      Settling the ratio here is the only place it can be settled against the
    ///      reserves that will actually be used. Exactly the settled amounts are
    ///      pulled, so nothing is over-approved and nothing is left behind.
    ///
    ///      The router holds no balance: everything pulled in this call is deposited
    ///      in the same call, and the shares are minted straight to `recipient`.
    function addLiquidity(
        address pool,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 minShares,
        address recipient,
        uint256 deadline
    ) external lock returns (uint256 amount0, uint256 amount1, uint256 shares) {
        if (block.timestamp > deadline) revert Expired();
        if (pool == address(0)) revert InvalidPath();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amount0Desired == 0 || amount1Desired == 0) revert InvalidAmount();
        // A zero floor accepts any ratio the reserves happen to hold when this is
        // mined, which is the same unguarded shape the pool refuses for a swap.
        if (amount0Min == 0 || amount1Min == 0 || minShares == 0) revert SlippageExceeded();

        (uint112 reserve0, uint112 reserve1, ) = ILocalSwapPool(pool).getReserves();
        (amount0, amount1) = _settleRatio(amount0Desired, amount1Desired, reserve0, reserve1);
        if (amount0 < amount0Min || amount1 < amount1Min) revert SlippageExceeded();

        // Split out because the token addresses and the post-conditions do not fit
        // in this frame alongside eight parameters.
        shares = _deposit(pool, amount0, amount1, minShares, recipient, deadline);
        emit RoutedLiquidity(msg.sender, pool, recipient, amount0, amount1, shares);
    }

    function _deposit(
        address pool,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        uint256 deadline
    ) private returns (uint256 shares) {
        address token0 = ILocalSwapPool(pool).token0();
        address token1 = ILocalSwapPool(pool).token1();
        _safeTransferFrom(token0, msg.sender, address(this), amount0);
        _safeTransferFrom(token1, msg.sender, address(this), amount1);
        _safeApprove(token0, pool, amount0);
        _safeApprove(token1, pool, amount1);

        shares = ILocalSwapPool(pool).addLiquidity(amount0, amount1, minShares, recipient, deadline);

        // The pool must have taken all of it. If it took less, this router is
        // holding tokens that belong to the caller, and an approval it granted is
        // still standing — the exact pair of problems this function exists to remove.
        if (
            IERC20RouterMinimal(token0).balanceOf(address(this)) != 0 ||
            IERC20RouterMinimal(token1).balanceOf(address(this)) != 0 ||
            IERC20RouterMinimal(token0).allowance(address(this), pool) != 0 ||
            IERC20RouterMinimal(token1).allowance(address(this), pool) != 0
        ) revert UnsupportedTokenBehavior();
    }

    /// @dev Mirrors the pool's own rounding, so the amounts pulled are exactly the
    ///      amounts it will credit. An empty pool takes both sides whole.
    function _settleRatio(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 reserve0,
        uint256 reserve1
    ) private pure returns (uint256 amount0, uint256 amount1) {
        if (reserve0 == 0 || reserve1 == 0) return (amount0Desired, amount1Desired);
        uint256 optimal1 = (amount0Desired * reserve1) / reserve0;
        if (optimal1 <= amount1Desired) return (amount0Desired, optimal1);
        uint256 optimal0 = (amount1Desired * reserve0) / reserve1;
        return (optimal0, amount1Desired);
    }

    function _assertUniqueToken(address[] memory visited, uint256 count, address token) private pure {
        for (uint256 i; i < count; ++i) if (visited[i] == token) revert InvalidPath();
    }

    function _validatePathLength(uint256 length) private pure {
        if (length == 0 || length > MAX_HOPS) revert InvalidPath();
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20RouterMinimal.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20RouterMinimal.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
