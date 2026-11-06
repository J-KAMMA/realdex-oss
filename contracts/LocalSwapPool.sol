// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title LocalSwapPool
/// @notice Immutable constant-product pool for one ERC-20 pair. It takes no
///         protocol fee: the swap fee stays in the pool and accrues to the
///         liquidity providers, and no address can withdraw it as revenue.
/// @dev This is original code, intentionally small, and has not been independently audited.
contract LocalSwapPool {
    string public constant name = "LocalSwap LP";
    string public constant symbol = "LS-LP";
    uint8 public constant decimals = 18;
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;

    /// @notice Swap fee in basis points, kept by the pool for its providers.
    /// @dev Without a fee, every arbitrage is a one-way transfer out of the
    ///      providers and nothing ever flows back, so providing liquidity is a
    ///      guaranteed loss. This is not a protocol fee: there is no recipient and
    ///      no address can withdraw it. It is set once at creation and can never
    ///      change, so the factory can offer tiers by creating separate pools.
    uint256 public immutable feeBasisPoints;
    uint256 public constant MINIMUM_FEE_BASIS_POINTS = 1;
    uint256 public constant MAXIMUM_FEE_BASIS_POINTS = 100;
    uint256 private constant BASIS_POINTS = 10_000;

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 private unlocked = 1;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error Expired();
    error InvalidToken();
    error InvalidFee();
    error InvalidRecipient();
    error InsufficientAmount();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error UnsupportedTokenBehavior();
    error TransferFailed();
    error Overflow();
    error Reentrancy();

    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event LiquidityAdded(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 shares);
    event LiquidityRemoved(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 shares);
    event Swap(address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed recipient);
    event Sync(uint112 reserve0, uint112 reserve1);
    event Skim(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1);

    modifier lock() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    modifier beforeDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    constructor(address tokenA, address tokenB, uint256 feeBasisPoints_) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) revert InvalidToken();
        // A zero fee is rejected on purpose: it leaves providers with no way to be
        // paid at all, which is a property of the pool, not a choice per trade.
        if (feeBasisPoints_ < MINIMUM_FEE_BASIS_POINTS || feeBasisPoints_ > MAXIMUM_FEE_BASIS_POINTS) revert InvalidFee();
        factory = msg.sender;
        feeBasisPoints = feeBasisPoints_;
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function quoteExactIn(address tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        if (amountIn == 0) revert InsufficientAmount();
        if (tokenIn == token0) return _amountOut(amountIn, reserve0, reserve1);
        if (tokenIn == token1) return _amountOut(amountIn, reserve1, reserve0);
        revert InvalidToken();
    }

    function addLiquidity(
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        uint256 deadline
    ) external lock beforeDeadline(deadline) returns (uint256 shares) {
        if (amount0 == 0 || amount1 == 0) revert InsufficientAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        // Take only what the current ratio can credit. Depositing off-ratio used to
        // leave the surplus in the pool with no shares issued for it, a silent loss
        // to the depositor. Collecting less is safer than refunding: a refund path
        // that ever pays out too much would drain the pool, and this one cannot.
        if (totalSupply != 0) {
            uint256 optimal1 = (amount0 * reserve1) / reserve0;
            if (optimal1 <= amount1) amount1 = optimal1;
            else amount0 = (amount1 * reserve0) / reserve1;
            if (amount0 == 0 || amount1 == 0) revert InsufficientAmount();
        }

        uint256 balance0Before = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1Before = IERC20Minimal(token1).balanceOf(address(this));
        _safeTransferFrom(token0, msg.sender, address(this), amount0);
        _safeTransferFrom(token1, msg.sender, address(this), amount1);
        if (
            IERC20Minimal(token0).balanceOf(address(this)) - balance0Before != amount0 ||
            IERC20Minimal(token1).balanceOf(address(this)) - balance1Before != amount1
        ) revert UnsupportedTokenBehavior();

        if (totalSupply == 0) {
            uint256 rootK = _sqrt(amount0 * amount1);
            if (rootK <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            shares = rootK - MINIMUM_LIQUIDITY;
            _mint(address(1), MINIMUM_LIQUIDITY);
        } else {
            shares = _min((amount0 * totalSupply) / reserve0, (amount1 * totalSupply) / reserve1);
        }
        if (shares == 0 || shares < minShares) revert SlippageExceeded();
        _mint(recipient, shares);
        _sync();
        emit LiquidityAdded(msg.sender, recipient, amount0, amount1, shares);
    }

    function removeLiquidity(
        uint256 shares,
        uint256 minAmount0,
        uint256 minAmount1,
        address recipient,
        uint256 deadline
    ) external lock beforeDeadline(deadline) returns (uint256 amount0, uint256 amount1) {
        if (shares == 0) revert InsufficientAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        amount0 = (shares * reserve0) / totalSupply;
        amount1 = (shares * reserve1) / totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();
        if (amount0 < minAmount0 || amount1 < minAmount1) revert SlippageExceeded();

        _burn(msg.sender, shares);
        _safeTransfer(token0, recipient, amount0);
        _safeTransfer(token1, recipient, amount1);
        _sync();
        emit LiquidityRemoved(msg.sender, recipient, amount0, amount1, shares);
    }

    function swapExactIn(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external lock beforeDeadline(deadline) returns (uint256 amountOut) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        // The router already refuses this; the pool must not be the softer door.
        if (minAmountOut == 0) revert SlippageExceeded();
        amountOut = quoteExactIn(tokenIn, amountIn);
        if (amountOut < minAmountOut) revert SlippageExceeded();

        bool zeroForOne = tokenIn == token0;
        address tokenOut = zeroForOne ? token1 : token0;
        uint256 balanceBefore = IERC20Minimal(tokenIn).balanceOf(address(this));
        _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        if (IERC20Minimal(tokenIn).balanceOf(address(this)) - balanceBefore != amountIn) {
            revert UnsupportedTokenBehavior();
        }
        _safeTransfer(tokenOut, recipient, amountOut);
        _sync();
        emit Swap(msg.sender, tokenIn, amountIn, amountOut, recipient);
    }

    /// @notice Records direct token donations in reserves. Anyone may call it.
    function sync() external lock {
        _sync();
    }

    /// @notice Sends any balance held above the recorded reserves to `to`.
    /// @dev Deliberately does not write reserves. `_sync()` reverts once a balance
    ///      passes the uint112 ceiling, and every other state-changing entry point
    ///      ends in `_sync()`, so without a path that still works in exactly that
    ///      state a balance pushed past the ceiling would lock the pool for good
    ///      and strand every liquidity provider. Anyone may call it: the excess is
    ///      not owned by anyone until it has been synced into reserves.
    function skim(address to) external lock {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        uint256 excess0 = IERC20Minimal(token0).balanceOf(address(this)) - reserve0;
        uint256 excess1 = IERC20Minimal(token1).balanceOf(address(this)) - reserve1;
        if (excess0 == 0 && excess1 == 0) revert InsufficientAmount();
        if (excess0 != 0) _safeTransfer(token0, to, excess0);
        if (excess1 != 0) _safeTransfer(token1, to, excess1);
        emit Skim(msg.sender, to, excess0, excess1);
    }

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private view returns (uint256) {
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        // The fee is withheld from the input and stays in the pool, so every swap
        // raises the invariant slightly and that gain belongs to the providers.
        uint256 amountInAfterFee = amountIn * (BASIS_POINTS - feeBasisPoints);
        return (amountInAfterFee * reserveOut) / (reserveIn * BASIS_POINTS + amountInAfterFee);
    }

    function _sync() private {
        uint256 balance0Now = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1Now = IERC20Minimal(token1).balanceOf(address(this));
        if (balance0Now > type(uint112).max || balance1Now > type(uint112).max) revert Overflow();
        reserve0 = uint112(balance0Now);
        reserve1 = uint112(balance1Now);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidRecipient();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) private {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) private {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _sqrt(uint256 value) private pure returns (uint256 result) {
        if (value == 0) return 0;
        result = 1 << (_log2(value) >> 1);
        unchecked {
            for (uint256 i; i < 7; ++i) result = (result + value / result) >> 1;
            return result < value / result ? result : value / result;
        }
    }

    function _log2(uint256 value) private pure returns (uint256 result) {
        while (value > 1) {
            value >>= 1;
            result++;
        }
    }
}
