// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SplitVault} from "./SplitVault.sol";

/// @title SplitVaultFactory (v3)
/// @notice Crea un SplitVault (clon EIP-1167) por vendedor, define la tesorería y
///         el fee de la plataforma, y lleva el registro vendedor => vault (con rotación).
/// @dev v3: todo cambio de fee se programa y entra en vigor FEE_CHANGE_DELAY después.
///      Mientras tanto cualquiera puede llamar distribute() en cualquier vault y repartir
///      lo ya cobrado con el fee anterior.
contract SplitVaultFactory is Ownable {
    /// @notice Tope de fee: 10%. No se puede superar ni siendo owner.
    uint16 public constant MAX_FEE_BPS = 1_000;
    /// @notice Retraso obligatorio de cualquier cambio de fee. Fijo: ni el owner lo puede acortar.
    uint64 public constant FEE_CHANGE_DELAY = 7 days;

    address public immutable implementation;
    /// @notice Token en el que se cobra (USDC). Se reparte al vendedor anterior al rotar.
    address public immutable settlementToken;
    address public treasury;

    uint16 private _feeBps;
    uint16 private _pendingFeeBps;
    uint64 private _feeEffectiveAt; // 0 = no hay cambio programado

    /// @notice vendedor => su vault (se actualiza cuando el vendedor rota su dirección)
    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed merchant, address indexed vault);
    event MerchantRotated(address indexed vault, address indexed previousMerchant, address indexed newMerchant);
    event TreasuryUpdated(address indexed treasury);
    event FeeUpdated(uint16 feeBps);
    event FeeChangeScheduled(uint16 feeBps, uint64 effectiveAt);
    event FeeChangeCancelled(uint16 feeBps);

    error ZeroAddress();
    error FeeTooHigh();
    error VaultExists();
    error NotVault();
    error MerchantRetired();
    error CounterfactualFunds();
    error NoFeeChange();

    constructor(address initialOwner, address treasury_, uint16 feeBps_, address settlementToken_)
        Ownable(initialOwner)
    {
        if (treasury_ == address(0) || settlementToken_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();

        implementation = address(new SplitVault());
        settlementToken = settlementToken_;
        treasury = treasury_;
        _feeBps = feeBps_;
    }

    /// @notice Crea el vault de `merchant`. Es permissionless: el dinero
    ///         solo puede ir al propio vendedor y a la tesorería.
    function createVault(address merchant) external returns (address vault) {
        if (merchant == address(0)) revert ZeroAddress();
        if (vaultOf[merchant] != address(0)) revert VaultExists();
        // Su vault original ya existe y pertenece a otra dirección (rotó)
        if (predictVault(merchant).code.length > 0) revert MerchantRetired();

        vault = Clones.cloneDeterministic(implementation, _salt(merchant));
        // El clon recién creado ejecuta código propio (la implementación), sin llamadas externas:
        // no puede reentrar (falso positivo de Slither).
        // slither-disable-next-line reentrancy-no-eth,reentrancy-events
        SplitVault(vault).initialize(address(this), merchant);
        vaultOf[merchant] = vault;

        emit VaultCreated(merchant, vault);
    }

    /// @notice Dirección determinística del vault original de `merchant`.
    function predictVault(address merchant) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(merchant));
    }

    /// @notice Dirección a la que se le debe cobrar a `merchant` (payTo de x402):
    ///         su vault registrado, o el predicho si todavía no existe.
    ///         Revierte si `merchant` rotó a otra dirección (cobrarle ahí pagaría a otro).
    function resolvePayTo(address merchant) external view returns (address) {
        address registered = vaultOf[merchant];
        if (registered != address(0)) return registered;
        address predicted = predictVault(merchant);
        if (predicted.code.length > 0) revert MerchantRetired();
        return predicted;
    }

    /// @notice Solo la llama un vault durante acceptMerchant(): mueve el registro
    ///         de la dirección anterior a la nueva.
    function onMerchantRotated(address previousMerchant, address newMerchant) external {
        if (vaultOf[previousMerchant] != msg.sender) revert NotVault();
        if (newMerchant == address(0)) revert ZeroAddress();
        if (vaultOf[newMerchant] != address(0)) revert VaultExists();
        // Pagos enviados al vault predicho (aún sin crear) de la nueva dirección quedarían
        // atorados, porque esa dirección ya no podría crear su vault original.
        address predicted = predictVault(newMerchant);
        if (predicted.code.length == 0 && IERC20(settlementToken).balanceOf(predicted) > 0) {
            revert CounterfactualFunds();
        }

        delete vaultOf[previousMerchant];
        vaultOf[newMerchant] = msg.sender;

        emit MerchantRotated(msg.sender, previousMerchant, newMerchant);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Fee vigente en este momento (lo usa cada vault al repartir).
    /// @dev El retraso es de 7 días: unos segundos de margen del validador en block.timestamp
    ///      no importan (por eso se ignora el detector `timestamp` de Slither aquí y abajo).
    function feeBps() public view returns (uint16) {
        // slither-disable-next-line timestamp
        if (_feeEffectiveAt != 0 && block.timestamp >= _feeEffectiveAt) return _pendingFeeBps;
        return _feeBps;
    }

    /// @notice Cambio de fee programado que todavía no aplica: (0, 0) si no hay ninguno.
    function pendingFeeChange() external view returns (uint16 newFeeBps, uint64 effectiveAt) {
        // slither-disable-next-line timestamp
        if (_feeEffectiveAt != 0 && block.timestamp < _feeEffectiveAt) {
            return (_pendingFeeBps, _feeEffectiveAt);
        }
        return (0, 0);
    }

    /// @notice Programa un cambio de fee que entra en vigor dentro de FEE_CHANGE_DELAY.
    ///         Si ya había uno programado, lo reemplaza y el plazo vuelve a empezar.
    function scheduleFeeChange(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        _settleFee();
        _pendingFeeBps = newFeeBps;
        _feeEffectiveAt = uint64(block.timestamp) + FEE_CHANGE_DELAY;
        emit FeeChangeScheduled(newFeeBps, _feeEffectiveAt);
    }

    /// @notice Cancela el cambio de fee programado (si todavía no entró en vigor).
    function cancelFeeChange() external onlyOwner {
        _settleFee();
        // slither-disable-next-line timestamp
        if (_feeEffectiveAt == 0) revert NoFeeChange();
        uint16 cancelled = _pendingFeeBps;
        _pendingFeeBps = 0;
        _feeEffectiveAt = 0;
        emit FeeChangeCancelled(cancelled);
    }

    /// @dev Si un cambio programado ya entró en vigor, lo consolida como fee vigente.
    function _settleFee() internal {
        // slither-disable-next-line timestamp
        if (_feeEffectiveAt != 0 && block.timestamp >= _feeEffectiveAt) {
            _feeBps = _pendingFeeBps;
            _pendingFeeBps = 0;
            _feeEffectiveAt = 0;
            emit FeeUpdated(_feeBps);
        }
    }

    function _salt(address merchant) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(merchant)));
    }
}