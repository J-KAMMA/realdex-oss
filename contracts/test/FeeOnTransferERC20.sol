// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A token that delivers less than it is asked to send.
///
/// Test-only. The pool and the router both argue their safety from what a
/// transfer actually delivered rather than from what was requested, and both
/// revert with `UnsupportedTokenBehavior` when the two differ. A token that
/// keeps a cut on every transfer is the ordinary way that happens, and without
/// one on hand those branches were never executed.
contract FeeOnTransferERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    /// Basis points withheld from every transfer, out of 10,000.
    uint16 public immutable feeBasisPoints;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint16 feeBasisPoints_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        feeBasisPoints = feeBasisPoints_;
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
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    /// The sender is debited in full; the recipient receives the remainder, and
    /// the withheld part is burnt. Reporting success either way is the point:
    /// a caller that trusts the return value learns nothing.
    function _move(address from, address to, uint256 amount) private {
        uint256 withheld = (amount * feeBasisPoints) / 10_000;
        uint256 delivered = amount - withheld;
        balanceOf[from] -= amount;
        balanceOf[to] += delivered;
        totalSupply -= withheld;
        emit Transfer(from, to, delivered);
    }
}
