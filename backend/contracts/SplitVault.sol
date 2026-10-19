// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/// @notice Configuración global que el vault lee de la factory.
interface ISplitConfig {
    function treasury() external view returns (address);
    function feeBps() external view returns (uint16);
}

/// @title SplitVault
/// @notice Dirección payTo de un vendedor. Recibe pagos x402 (USDC) y los reparte
///         entre la tesorería de Sekisho (fee) y el vendedor.
contract SplitVault is Initializable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public factory;
    address public merchant;

    event Distributed(
        address indexed token,
        uint256 total,
        uint256 fee,
        uint256 merchantAmount
    );

    error ZeroAddress();
    error NothingToDistribute();

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