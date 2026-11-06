// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./RealDexSmartAccount.sol";
/// @notice Permissionless CREATE2 factory. Constructor-bound owner; no admin, proxies or upgrades.
contract RealDexSmartAccountFactory {
    event AccountCreated(address indexed account, address indexed owner, bytes32 salt);
    function getAddress(address owner, bytes32 salt) public view returns (address) {
        bytes32 derivedSalt = keccak256(abi.encode(owner, salt));
        bytes32 initHash = keccak256(abi.encodePacked(type(RealDexSmartAccount).creationCode, abi.encode(owner)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), derivedSalt, initHash)))));
    }
    function createAccount(address owner, bytes32 salt) external returns (address account) {
        account = getAddress(owner, salt);
        if (account.code.length != 0) return account;
        account = address(new RealDexSmartAccount{salt:keccak256(abi.encode(owner,salt))}(owner));
        emit AccountCreated(account, owner, salt);
    }
}
