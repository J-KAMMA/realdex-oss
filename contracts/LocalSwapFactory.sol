// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LocalSwapPool} from "./LocalSwapPool.sol";

/// @title LocalSwapFactory
/// @notice Permissionless and immutable pool registry. It has no owner or administrative controls.
/// @dev A pair may have one pool per fee tier. The fee is fixed in the pool at
///      creation and can never change, so offering a different fee means creating
///      a separate pool rather than altering an existing one. Nothing here ranks
///      or endorses a tier; callers name the pool they mean.
contract LocalSwapFactory {
    mapping(address => mapping(address => mapping(uint256 => address))) public getPool;
    address[] public allPools;

    error InvalidToken();
    error PoolExists();

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint256 indexed feeBasisPoints,
        address pool,
        uint256 poolCount
    );

    function createPool(address tokenA, address tokenB, uint256 feeBasisPoints) external returns (address pool) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) revert InvalidToken();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (getPool[token0][token1][feeBasisPoints] != address(0)) revert PoolExists();

        // The fee is part of the identity: two tiers for one pair are two pools at
        // two addresses, never one address behaving differently at different times.
        bytes32 salt = keccak256(abi.encodePacked(token0, token1, feeBasisPoints));
        // The pool rejects a fee outside its own bounds, so nothing is duplicated here.
        pool = address(new LocalSwapPool{salt: salt}(token0, token1, feeBasisPoints));
        getPool[token0][token1][feeBasisPoints] = pool;
        getPool[token1][token0][feeBasisPoints] = pool;
        allPools.push(pool);
        emit PoolCreated(token0, token1, feeBasisPoints, pool, allPools.length);
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }
}
