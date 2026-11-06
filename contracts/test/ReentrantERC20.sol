// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A token that calls back into whoever is moving it.
///
/// Test-only. ERC-20 has no recipient hook, so the way back into a pool
/// mid-operation is the token itself: the pool sends the output token, and that
/// token's `transfer` calls the pool again while the reserves are still the ones
/// from before the swap. `lock` exists for exactly this, and nothing in the suite
/// had ever made it fire.
///
/// The callback records the outcome instead of reverting, so a test can assert
/// two separate things: that the re-entrant call was refused, with which error,
/// and that the outer call still finished correctly.
contract ReentrantERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public target;
    bytes public payload;
    bool public armed;
    /// Whether the callback ran, whether it succeeded, and what it returned.
    bool public attempted;
    bool public succeeded;
    bytes public result;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    /// Fires once, on the next transfer of any kind. Setting it up separately
    /// keeps the token honest while a fixture is being built.
    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
        attempted = false;
        succeeded = false;
        result = "";
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        _callBack();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        _callBack();
        return true;
    }

    /// The delivered amount is moved first, so the caller's own
    /// delivered-versus-requested check still passes and what is under test is
    /// the re-entry rather than a short transfer.
    function _callBack() private {
        if (!armed) return;
        armed = false;
        attempted = true;
        (bool ok, bytes memory data) = target.call(payload);
        succeeded = ok;
        result = data;
    }
}
