// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Non-upgradeable, single-owner smart account. Experimental; not audited.
/// @dev No delegatecall, modules, EntryPoint, paymaster, upgrade or guardian recovery.
contract RealDexSmartAccount {
    struct Call { address target; uint256 value; bytes data; }
    struct Session {
        address recipient;
        address token;
        bytes32 tokenCodeHash;
        uint128 perCallLimit;
        uint128 dailyLimit;
        uint128 totalLimit;
        uint128 spent;
        uint128 daySpent;
        uint48 validUntil;
        uint64 day;
        uint256 epoch;
        uint256 generation;
    }
    address public immutable owner;
    address public immutable factory;
    uint256 public executionNonce;
    uint256 public sessionEpoch = 1;
    uint256 public signatureEpoch = 1;
    mapping(address => Session) public sessions;
    mapping(address => uint256) public sessionNonces;
    mapping(address => uint256) public sessionGenerations;
    bool private entered;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant MESSAGE_TYPEHASH = keccak256("SmartAccountMessage(bytes32 hash,uint48 validUntil,uint256 epoch)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    event BatchExecuted(uint256 indexed nonce, bytes32 callsHash);
    event SessionGranted(address indexed key, address indexed recipient, address indexed token, uint256 generation, uint48 validUntil);
    event SessionRevoked(address indexed key, uint256 generation);
    event AllSessionsRevoked(uint256 epoch);
    event SessionSpent(address indexed key, address indexed recipient, address indexed token, uint256 generation, uint256 nonce, uint256 amount);
    event SignaturesInvalidated(uint256 epoch);
    error Unauthorized(); error InvalidInput(); error ReentrantCall(); error Expired();
    error NonceMismatch(); error CallFailed(uint256 index); error TokenTransferFailed(); error BudgetExceeded();

    constructor(address initialOwner) {
        if (initialOwner == address(0) || initialOwner.code.length != 0) revert InvalidInput();
        owner = initialOwner; factory = msg.sender;
    }
    receive() external payable {}
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier nonReentrant() { if (entered) revert ReentrantCall(); entered = true; _; entered = false; }

    /// @notice All calls either succeed together or revert together. Gas is paid by the owner EOA.
    function executeBatch(Call[] calldata calls, uint256 expectedNonce, uint48 validUntil)
        external onlyOwner nonReentrant returns (bytes[] memory results)
    {
        if (calls.length == 0 || calls.length > 8) revert InvalidInput();
        if (validUntil <= block.timestamp || validUntil > block.timestamp + 10 minutes) revert Expired();
        if (expectedNonce != executionNonce) revert NonceMismatch();
        executionNonce++;
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            if (c.target == address(0) || c.target == address(this) || (c.data.length != 0 && c.target.code.length == 0)) revert InvalidInput();
            (bool ok, bytes memory result) = c.target.call{value: c.value}(c.data);
            if (!ok) revert CallFailed(i);
            // ERC20 can report a failure without reverting. Do not silently accept it.
            if (c.data.length >= 4) {
                bytes4 sel = bytes4(c.data[:4]);
                if (sel == 0xa9059cbb || sel == 0x095ea7b3 || sel == 0x23b872dd) {
                    if (c.value != 0 || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TokenTransferFailed();
                }
            }
            results[i] = result;
        }
        emit BatchExecuted(expectedNonce, keccak256(abi.encode(calls)));
    }

    /// @notice A key may only send one asset to one recipient. Daily means UTC calendar day, not rolling 24h.
    function grantSession(address key, address recipient, address token, uint128 perCallLimit,
        uint128 dailyLimit, uint128 totalLimit, uint48 validUntil) external onlyOwner nonReentrant
    {
        if (key == address(0) || key == owner || key == address(this) || key.code.length != 0 ||
            recipient == address(0) || recipient == address(this) || perCallLimit == 0 ||
            perCallLimit > dailyLimit || dailyLimit > totalLimit || (token != address(0) && token.code.length == 0)) revert InvalidInput();
        if (validUntil <= block.timestamp || validUntil > block.timestamp + 7 days) revert Expired();
        uint256 generation = ++sessionGenerations[key];
        sessions[key] = Session(recipient, token, token == address(0) ? bytes32(0) : token.codehash,
            perCallLimit, dailyLimit, totalLimit, 0, 0, validUntil, uint64(block.timestamp / 1 days), sessionEpoch, generation);
        emit SessionGranted(key, recipient, token, generation, validUntil);
    }
    function revokeSession(address key) external onlyOwner nonReentrant {
        uint256 generation = ++sessionGenerations[key];
        delete sessions[key]; emit SessionRevoked(key, generation);
    }
    function revokeAllSessions() external onlyOwner nonReentrant {
        ++sessionEpoch; emit AllSessionsRevoked(sessionEpoch);
    }
    /// @notice The session key pays its own gas. The smart account pays only the specified asset amount.
    function sessionTransfer(uint256 generation, uint256 expectedNonce, uint256 amount) external nonReentrant {
        Session storage s = sessions[msg.sender];
        if (s.epoch != sessionEpoch || s.generation != generation || generation != sessionGenerations[msg.sender] || msg.sender.code.length != 0) revert Unauthorized();
        if (block.timestamp >= s.validUntil) revert Expired();
        if (expectedNonce != sessionNonces[msg.sender]) revert NonceMismatch();
        if (amount == 0 || amount > s.perCallLimit || amount > uint256(s.totalLimit) - s.spent) revert BudgetExceeded();
        uint64 day = uint64(block.timestamp / 1 days);
        if (s.day != day) { s.day = day; s.daySpent = 0; }
        if (amount > uint256(s.dailyLimit) - s.daySpent) revert BudgetExceeded();
        s.spent += uint128(amount); s.daySpent += uint128(amount); ++sessionNonces[msg.sender];
        if (s.token == address(0)) {
            (bool ok,) = s.recipient.call{value:amount}(""); if (!ok) revert CallFailed(0);
        } else {
            if (s.token.codehash != s.tokenCodeHash) revert TokenTransferFailed();
            uint256 beforeSelf = _balance(s.token, address(this));
            uint256 beforeRecipient = _balance(s.token, s.recipient);
            (bool ok, bytes memory result) = s.token.call(abi.encodeWithSelector(bytes4(0xa9059cbb), s.recipient, amount));
            if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result,(bool))))) revert TokenTransferFailed();
            uint256 afterSelf = _balance(s.token, address(this));
            uint256 afterRecipient = _balance(s.token, s.recipient);
            if (afterSelf > beforeSelf || beforeSelf - afterSelf != amount || afterRecipient < beforeRecipient || afterRecipient - beforeRecipient != amount) revert TokenTransferFailed();
        }
        emit SessionSpent(msg.sender, s.recipient, s.token, generation, expectedNonce, amount);
    }
    function _balance(address token, address account) private view returns (uint256 value) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSelector(bytes4(0x70a08231), account));
        if (!ok || r.length != 32) revert TokenTransferFailed(); value = abi.decode(r,(uint256));
    }

    function invalidateSignatures() external onlyOwner nonReentrant { ++signatureEpoch; emit SignaturesInvalidated(signatureEpoch); }
    function messageDigest(bytes32 hash, uint48 validUntil) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("RealDEX Smart Account"), keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(MESSAGE_TYPEHASH, hash, validUntil, signatureEpoch))));
    }
    /// @dev ERC1271 envelope: uint48 deadline (6B) || uint256 epoch (32B) || r (32B) || s (32B) || v (1B).
    /// The owner signs messageDigest(hash,deadline), NOT the raw application hash. Prevents cross-account replay.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 103) return 0xffffffff;
        uint48 deadline; uint256 epoch; bytes32 r; bytes32 s; uint8 v;
        assembly {
            deadline := shr(208, calldataload(signature.offset))
            epoch := calldataload(add(signature.offset, 6))
            r := calldataload(add(signature.offset, 38))
            s := calldataload(add(signature.offset, 70))
            v := byte(0, calldataload(add(signature.offset, 102)))
        }
        if (deadline <= block.timestamp || epoch != signatureEpoch || uint256(s) > HALF_ORDER || uint256(s) == 0 || (v != 27 && v != 28)) return 0xffffffff;
        return ecrecover(messageDigest(hash, deadline), v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
