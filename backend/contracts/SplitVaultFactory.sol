// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SplitVault} from "./SplitVault.sol";

/// @title SplitVaultFactory
/// @notice Crea un SplitVault (clon EIP-1167) por vendedor y define
///         la tesorería y el fee de la plataforma.
contract SplitVaultFactory is Ownable {
    /// @notice Tope de fee: 10%. No se puede superar ni siendo owner.
    uint16 public constant MAX_FEE_BPS = 1_000;

    address public immutable implementation;
    address public treasury;
    uint16 public feeBps;

    /// @notice vendedor => su vault
    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed merchant, address indexed vault);
    event TreasuryUpdated(address indexed treasury);
    event FeeUpdated(uint16 feeBps);

    error ZeroAddress();
    error FeeTooHigh();
    error VaultExists();

    constructor(address initialOwner, address treasury_, uint16 feeBps_)
        Ownable(initialOwner)
    {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();

        implementation = address(new SplitVault());
        treasury = treasury_;
        feeBps = feeBps_;
    }

    /// @notice Crea el vault de `merchant`. Es permissionless: el dinero
    ///         solo puede ir al propio vendedor y a la tesorería.
    function createVault(address merchant) external returns (address vault) {
        if (merchant == address(0)) revert ZeroAddress();
        if (vaultOf[merchant] != address(0)) revert VaultExists();

        vault = Clones.cloneDeterministic(implementation, _salt(merchant));
        SplitVault(vault).initialize(address(this), merchant);
        vaultOf[merchant] = vault;

        emit VaultCreated(merchant, vault);
    }

    /// @notice Dirección del vault de `merchant`, exista o no todavía.
    ///         Sirve como payTo de x402 desde el primer momento.
    function predictVault(address merchant) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(merchant));
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    function _salt(address merchant) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(merchant)));
    }
}