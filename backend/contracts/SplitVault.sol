// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/// @notice Configuración global y registro que el vault usa de la factory.
interface ISplitConfig {
    function treasury() external view returns (address);
    function feeBps() external view returns (uint16);
    function settlementToken() external view returns (address);
    function onMerchantRotated(address previousMerchant, address newMerchant) external;
}

/// @title SplitVault (v2)
/// @notice Dirección payTo de un vendedor. Recibe pagos x402 (USDC) y los reparte
///         entre la tesorería de Sekisho (fee) y el vendedor.
/// @dev No existe ninguna función de retiro: todo lo que entra solo puede salir por
///      distribute(), hacia la tesorería y el vendedor, en la proporción del contrato.
///      El vault tampoco acepta AVAX nativo (no tiene receive ni fallback).
contract SplitVault is Initializable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public factory;
    address public merchant;
    /// @notice Dirección propuesta por el vendedor para recibir sus pagos (rotación en dos pasos).
    address public pendingMerchant;

    event Distributed(
        address indexed token,
        uint256 total,
        uint256 fee,
        uint256 merchantAmount
    );
    event MerchantProposed(address indexed merchant, address indexed proposed);
    event MerchantChanged(address indexed previousMerchant, address indexed newMerchant);

    error ZeroAddress();
    error NothingToDistribute();
    error NotMerchant();
    error NotPendingMerchant();
    error SameMerchant();

    /// @dev Bloquea la implementación base; solo los clones se inicializan.
    constructor() {
        _disableInitializers();
    }

    /// @notice Se llama una sola vez, desde la factory, al crear el clon.
    function initialize(address factory_, address merchant_) external initializer {
        if (factory_ == address(0) || merchant_ == address(0)) revert ZeroAddress();
        factory = factory_;
        merchant = merchant_;
    }

    /// @notice Muestra cuánto se repartiría si se llama distribute(token) ahora.
    function pending(address token)
        external
        view
        returns (uint256 total, uint256 fee, uint256 merchantAmount)
    {
        total = IERC20(token).balanceOf(address(this));
        (fee, merchantAmount) = _split(total);
    }

    /// @notice Reparte todo el saldo de `token`. Cualquiera puede llamarla:
    ///         los destinos (tesorería y vendedor) son fijos.
    function distribute(address token)
        external
        returns (uint256 fee, uint256 merchantAmount)
    {
        uint256 total = IERC20(token).balanceOf(address(this));
        if (total == 0) revert NothingToDistribute();
        (fee, merchantAmount) = _distribute(token, total);
    }

    /// @notice Paso 1 de la rotación: el vendedor propone su nueva dirección.
    ///         Proponer address(0) cancela una propuesta pendiente.
    function proposeMerchant(address newMerchant) external {
        if (msg.sender != merchant) revert NotMerchant();
        if (newMerchant == merchant) revert SameMerchant();
        pendingMerchant = newMerchant;
        emit MerchantProposed(merchant, newMerchant);
    }

    /// @notice Paso 2: la nueva dirección acepta. Antes de cambiar, el saldo pendiente
    ///         del token de liquidación (USDC) se reparte al vendedor ANTERIOR.
    function acceptMerchant() external {
        address newMerchant = pendingMerchant;
        if (newMerchant == address(0) || msg.sender != newMerchant) revert NotPendingMerchant();

        // Lo cobrado antes de la rotación es del vendedor anterior
        address token = ISplitConfig(factory).settlementToken();
        uint256 total = IERC20(token).balanceOf(address(this));
        if (total > 0) _distribute(token, total);

        address previousMerchant = merchant;
        merchant = newMerchant;
        pendingMerchant = address(0);

        // La factory actualiza su registro vendedor => vault (y valida la nueva dirección)
        ISplitConfig(factory).onMerchantRotated(previousMerchant, newMerchant);

        emit MerchantChanged(previousMerchant, newMerchant);
    }

    function _distribute(address token, uint256 total)
        internal
        returns (uint256 fee, uint256 merchantAmount)
    {
        (fee, merchantAmount) = _split(total);

        if (fee > 0) {
            IERC20(token).safeTransfer(ISplitConfig(factory).treasury(), fee);
        }
        IERC20(token).safeTransfer(merchant, merchantAmount);

        emit Distributed(token, total, fee, merchantAmount);
    }

    /// @dev El redondeo favorece al vendedor (el fee redondea hacia abajo).
    function _split(uint256 total)
        internal
        view
        returns (uint256 fee, uint256 merchantAmount)
    {
        fee = (total * ISplitConfig(factory).feeBps()) / BPS_DENOMINATOR;
        merchantAmount = total - fee;
    }
}