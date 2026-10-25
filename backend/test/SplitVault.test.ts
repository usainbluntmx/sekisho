import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const FEE_BPS = 150; // 1.5%
const usdc = (amount: string) => ethers.parseUnits(amount, 6);

describe("Sekisho: SplitVaultFactory + SplitVault", function () {
  async function deployFixture() {
    const [owner, treasury, merchant, payer, other] = await ethers.getSigners();

    const token = await ethers.deployContract("MockUSDC");
    const factory = await ethers.deployContract("SplitVaultFactory", [
      owner.address,
      treasury.address,
      FEE_BPS,
      await token.getAddress(),
    ]);

    return { owner, treasury, merchant, payer, other, token, factory };
  }

  async function vaultFixture() {
    const base = await deployFixture();
    await base.factory.createVault(base.merchant.address);
    const vaultAddress = await base.factory.vaultOf(base.merchant.address);
    const vault = await ethers.getContractAt("SplitVault", vaultAddress);

    // Simula un pago x402: el pagador transfiere USDC al vault (payTo)
    await base.token.mint(base.payer.address, usdc("1000"));

    return { ...base, vault, vaultAddress };
  }

  // ───────────────────────── Factory ─────────────────────────

  describe("SplitVaultFactory", function () {
    it("se despliega con la configuración correcta", async function () {
      const { owner, treasury, factory, token } = await loadFixture(deployFixture);

      expect(await factory.owner()).to.equal(owner.address);
      expect(await factory.treasury()).to.equal(treasury.address);
      expect(await factory.feeBps()).to.equal(FEE_BPS);
      expect(await factory.implementation()).to.not.equal(ethers.ZeroAddress);
      expect(await factory.settlementToken()).to.equal(await token.getAddress());
    });

    it("rechaza un fee mayor al 10% en el deploy", async function () {
      const [owner, treasury] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("SplitVaultFactory");

      await expect(
        Factory.deploy(owner.address, treasury.address, 1001, owner.address)
      ).to.be.revertedWithCustomError(Factory, "FeeTooHigh");
    });

    it("rechaza un token de liquidación en address(0)", async function () {
      const [owner, treasury] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("SplitVaultFactory");

      await expect(
        Factory.deploy(owner.address, treasury.address, FEE_BPS, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });

    it("rechaza una tesorería en address(0)", async function () {
      const [owner] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("SplitVaultFactory");

      await expect(
        Factory.deploy(owner.address, ethers.ZeroAddress, FEE_BPS, owner.address)
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });

    it("crea el vault en la dirección predicha y emite VaultCreated", async function () {
      const { merchant, factory } = await loadFixture(deployFixture);

      const predicted = await factory.predictVault(merchant.address);

      await expect(factory.createVault(merchant.address))
        .to.emit(factory, "VaultCreated")
        .withArgs(merchant.address, predicted);

      expect(await factory.vaultOf(merchant.address)).to.equal(predicted);

      const vault = await ethers.getContractAt("SplitVault", predicted);
      expect(await vault.merchant()).to.equal(merchant.address);
      expect(await vault.factory()).to.equal(await factory.getAddress());
    });

    it("no permite crear dos vaults para el mismo vendedor", async function () {
      const { merchant, factory } = await loadFixture(deployFixture);

      await factory.createVault(merchant.address);
      await expect(
        factory.createVault(merchant.address)
      ).to.be.revertedWithCustomError(factory, "VaultExists");
    });

    it("no permite crear un vault para address(0)", async function () {
      const { factory } = await loadFixture(deployFixture);

      await expect(
        factory.createVault(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("solo el owner puede cambiar fee y tesorería", async function () {
      const { other, factory } = await loadFixture(deployFixture);

      await expect(factory.connect(other).setFeeBps(100))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(other.address);

      await expect(factory.connect(other).setTreasury(other.address))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
    });

    it("el owner puede cambiar la tesorería, pero no a address(0)", async function () {
      const { other, factory } = await loadFixture(deployFixture);

      await expect(factory.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress"
      );
      await expect(factory.setTreasury(other.address))
        .to.emit(factory, "TreasuryUpdated")
        .withArgs(other.address);
      expect(await factory.treasury()).to.equal(other.address);
    });

    it("el owner no puede subir el fee por encima del 10%", async function () {
      const { factory } = await loadFixture(deployFixture);

      await expect(factory.setFeeBps(1001)).to.be.revertedWithCustomError(
        factory,
        "FeeTooHigh"
      );
      await expect(factory.setFeeBps(1000))
        .to.emit(factory, "FeeUpdated")
        .withArgs(1000);
    });
  });

  // ───────────────────────── Vault ─────────────────────────

  describe("SplitVault", function () {
    it("reparte el pago: 1.5% a tesorería y el resto al vendedor", async function () {
      const { treasury, merchant, payer, token, vault, vaultAddress } =
        await loadFixture(vaultFixture);

      await token.connect(payer).transfer(vaultAddress, usdc("100"));

      await expect(vault.distribute(await token.getAddress()))
        .to.emit(vault, "Distributed")
        .withArgs(await token.getAddress(), usdc("100"), usdc("1.5"), usdc("98.5"));

      expect(await token.balanceOf(treasury.address)).to.equal(usdc("1.5"));
      expect(await token.balanceOf(merchant.address)).to.equal(usdc("98.5"));
      expect(await token.balanceOf(vaultAddress)).to.equal(0n);
    });

    it("pending() muestra el reparto antes de ejecutarlo", async function () {
      const { payer, token, vault, vaultAddress } = await loadFixture(vaultFixture);

      await token.connect(payer).transfer(vaultAddress, usdc("10"));

      const [total, fee, merchantAmount] = await vault.pending(
        await token.getAddress()
      );
      expect(total).to.equal(usdc("10"));
      expect(fee).to.equal(usdc("0.15"));
      expect(merchantAmount).to.equal(usdc("9.85"));
    });

    it("cualquiera puede llamar distribute(), pero los fondos van a los destinos fijos", async function () {
      const { treasury, merchant, payer, other, token, vault, vaultAddress } =
        await loadFixture(vaultFixture);

      await token.connect(payer).transfer(vaultAddress, usdc("100"));
      await vault.connect(other).distribute(await token.getAddress());

      expect(await token.balanceOf(other.address)).to.equal(0n);
      expect(await token.balanceOf(treasury.address)).to.equal(usdc("1.5"));
      expect(await token.balanceOf(merchant.address)).to.equal(usdc("98.5"));
    });

    it("revierte si no hay saldo para repartir", async function () {
      const { token, vault } = await loadFixture(vaultFixture);

      await expect(
        vault.distribute(await token.getAddress())
      ).to.be.revertedWithCustomError(vault, "NothingToDistribute");
    });

    it("el redondeo favorece al vendedor en montos mínimos", async function () {
      const { treasury, merchant, payer, token, vault, vaultAddress } =
        await loadFixture(vaultFixture);

      // 1 unidad = 0.000001 USDC → fee = 0
      await token.connect(payer).transfer(vaultAddress, 1n);
      await vault.distribute(await token.getAddress());

      expect(await token.balanceOf(treasury.address)).to.equal(0n);
      expect(await token.balanceOf(merchant.address)).to.equal(1n);
    });

    it("aplica el nuevo fee si el owner lo cambia", async function () {
      const { factory, treasury, merchant, payer, token, vault, vaultAddress } =
        await loadFixture(vaultFixture);

      await factory.setFeeBps(0);
      await token.connect(payer).transfer(vaultAddress, usdc("50"));
      await vault.distribute(await token.getAddress());

      expect(await token.balanceOf(treasury.address)).to.equal(0n);
      expect(await token.balanceOf(merchant.address)).to.equal(usdc("50"));
    });

    it("acepta pagos ANTES de que exista el vault (dirección predicha)", async function () {
      const { treasury, merchant, payer, token, factory } =
        await loadFixture(deployFixture);

      await token.mint(payer.address, usdc("20"));

      const predicted = await factory.predictVault(merchant.address);
      await token.connect(payer).transfer(predicted, usdc("20"));

      await factory.createVault(merchant.address);
      const vault = await ethers.getContractAt("SplitVault", predicted);
      await vault.distribute(await token.getAddress());

      expect(await token.balanceOf(treasury.address)).to.equal(usdc("0.3"));
      expect(await token.balanceOf(merchant.address)).to.equal(usdc("19.7"));
    });

    it("no se puede reinicializar un vault", async function () {
      const { other, vault } = await loadFixture(vaultFixture);

      await expect(
        vault.initialize(other.address, other.address)
      ).to.be.revertedWithCustomError(vault, "InvalidInitialization");
    });

    it("la implementación base no se puede inicializar", async function () {
      const { other, factory } = await loadFixture(deployFixture);

      const impl = await ethers.getContractAt(
        "SplitVault",
        await factory.implementation()
      );
      await expect(
        impl.initialize(other.address, other.address)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });
  // ───────────────────────── Rotación de vendedor (v2) ─────────────────────────

  describe("Rotación de vendedor (v2)", function () {
    async function rotationFixture() {
      const base = await vaultFixture();
      const [, , , , , newMerchant] = await ethers.getSigners();
      return { ...base, newMerchant };
    }

    it("solo el vendedor puede proponer una nueva dirección", async function () {
      const { other, newMerchant, vault } = await loadFixture(rotationFixture);

      await expect(
        vault.connect(other).proposeMerchant(newMerchant.address)
      ).to.be.revertedWithCustomError(vault, "NotMerchant");
    });

    it("no se puede proponer la misma dirección", async function () {
      const { merchant, vault } = await loadFixture(rotationFixture);

      await expect(
        vault.connect(merchant).proposeMerchant(merchant.address)
      ).to.be.revertedWithCustomError(vault, "SameMerchant");
    });

    it("solo la dirección propuesta puede aceptar", async function () {
      const { merchant, other, newMerchant, vault } = await loadFixture(rotationFixture);

      await expect(vault.connect(merchant).proposeMerchant(newMerchant.address))
        .to.emit(vault, "MerchantProposed")
        .withArgs(merchant.address, newMerchant.address);

      await expect(vault.connect(other).acceptMerchant()).to.be.revertedWithCustomError(
        vault,
        "NotPendingMerchant"
      );
      await expect(vault.connect(merchant).acceptMerchant()).to.be.revertedWithCustomError(
        vault,
        "NotPendingMerchant"
      );
    });

    it("proponer address(0) cancela la propuesta", async function () {
      const { merchant, newMerchant, vault } = await loadFixture(rotationFixture);

      await vault.connect(merchant).proposeMerchant(newMerchant.address);
      await vault.connect(merchant).proposeMerchant(ethers.ZeroAddress);

      expect(await vault.pendingMerchant()).to.equal(ethers.ZeroAddress);
      await expect(vault.connect(newMerchant).acceptMerchant()).to.be.revertedWithCustomError(
        vault,
        "NotPendingMerchant"
      );
    });

    it("al aceptar, lo pendiente se reparte al vendedor ANTERIOR y el registro se actualiza", async function () {
      const { treasury, merchant, newMerchant, payer, token, factory, vault, vaultAddress } =
        await loadFixture(rotationFixture);

      await token.connect(payer).transfer(vaultAddress, usdc("100"));
      await vault.connect(merchant).proposeMerchant(newMerchant.address);

      await expect(vault.connect(newMerchant).acceptMerchant())
        .to.emit(vault, "MerchantChanged")
        .withArgs(merchant.address, newMerchant.address)
        .and.to.emit(factory, "MerchantRotated")
        .withArgs(vaultAddress, merchant.address, newMerchant.address);

      // Lo cobrado antes de rotar fue para el vendedor anterior
      expect(await token.balanceOf(merchant.address)).to.equal(usdc("98.5"));
      expect(await token.balanceOf(treasury.address)).to.equal(usdc("1.5"));
      expect(await token.balanceOf(newMerchant.address)).to.equal(0n);

      expect(await vault.merchant()).to.equal(newMerchant.address);
      expect(await vault.pendingMerchant()).to.equal(ethers.ZeroAddress);
      expect(await factory.vaultOf(newMerchant.address)).to.equal(vaultAddress);
      expect(await factory.vaultOf(merchant.address)).to.equal(ethers.ZeroAddress);
    });

    it("después de rotar, los pagos nuevos van a la nueva dirección", async function () {
      const { treasury, merchant, newMerchant, payer, token, vault, vaultAddress } =
        await loadFixture(rotationFixture);

      await vault.connect(merchant).proposeMerchant(newMerchant.address);
      await vault.connect(newMerchant).acceptMerchant(); // sin saldo: no reparte nada

      await token.connect(payer).transfer(vaultAddress, usdc("10"));
      await vault.distribute(await token.getAddress());

      expect(await token.balanceOf(newMerchant.address)).to.equal(usdc("9.85"));
      expect(await token.balanceOf(treasury.address)).to.equal(usdc("0.15"));
      expect(await token.balanceOf(merchant.address)).to.equal(0n);
    });

    it("resolvePayTo: predicho antes de crear, el vault después y error para la dirección retirada", async function () {
      const { merchant, newMerchant, other, factory, vault, vaultAddress } =
        await loadFixture(rotationFixture);

      // Vendedor sin vault: dirección predicha
      expect(await factory.resolvePayTo(other.address)).to.equal(
        await factory.predictVault(other.address)
      );
      // Vendedor con vault
      expect(await factory.resolvePayTo(merchant.address)).to.equal(vaultAddress);

      await vault.connect(merchant).proposeMerchant(newMerchant.address);
      await vault.connect(newMerchant).acceptMerchant();

      expect(await factory.resolvePayTo(newMerchant.address)).to.equal(vaultAddress);
      await expect(factory.resolvePayTo(merchant.address)).to.be.revertedWithCustomError(
        factory,
        "MerchantRetired"
      );
    });

    it("la dirección retirada no puede crear otro vault", async function () {
      const { merchant, newMerchant, factory, vault } = await loadFixture(rotationFixture);

      await vault.connect(merchant).proposeMerchant(newMerchant.address);
      await vault.connect(newMerchant).acceptMerchant();

      await expect(factory.createVault(merchant.address)).to.be.revertedWithCustomError(
        factory,
        "MerchantRetired"
      );
    });

    it("no se puede rotar hacia una dirección que ya tiene vault", async function () {
      const { merchant, newMerchant, factory, vault } = await loadFixture(rotationFixture);

      await factory.createVault(newMerchant.address);
      await vault.connect(merchant).proposeMerchant(newMerchant.address);

      await expect(vault.connect(newMerchant).acceptMerchant()).to.be.revertedWithCustomError(
        factory,
        "VaultExists"
      );
    });

    it("no se puede rotar hacia una dirección con pagos en su vault predicho (quedarían atorados)", async function () {
      const { merchant, newMerchant, payer, token, factory, vault } =
        await loadFixture(rotationFixture);

      await token
        .connect(payer)
        .transfer(await factory.predictVault(newMerchant.address), usdc("1"));
      await vault.connect(merchant).proposeMerchant(newMerchant.address);

      await expect(vault.connect(newMerchant).acceptMerchant()).to.be.revertedWithCustomError(
        factory,
        "CounterfactualFunds"
      );
    });

    it("solo un vault registrado puede actualizar el registro de la factory", async function () {
      const { merchant, other, factory } = await loadFixture(rotationFixture);

      await expect(
        factory.connect(other).onMerchantRotated(merchant.address, other.address)
      ).to.be.revertedWithCustomError(factory, "NotVault");
    });

    it("el vault no tiene funciones de retiro (solo distribute mueve fondos)", async function () {
      const { vault } = await loadFixture(rotationFixture);

      const functions = vault.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as { name: string }).name)
        .sort();

      expect(functions).to.deep.equal(
        [
          "BPS_DENOMINATOR",
          "acceptMerchant",
          "distribute",
          "factory",
          "initialize",
          "merchant",
          "pending",
          "pendingMerchant",
          "proposeMerchant",
        ].sort()
      );
    });

    it("el vault rechaza AVAX nativo", async function () {
      const { payer, vaultAddress } = await loadFixture(rotationFixture);

      await expect(
        payer.sendTransaction({ to: vaultAddress, value: ethers.parseEther("1") })
      ).to.be.reverted;
    });
  });
});