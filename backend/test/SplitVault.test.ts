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
      const { owner, treasury, factory } = await loadFixture(deployFixture);

      expect(await factory.owner()).to.equal(owner.address);
      expect(await factory.treasury()).to.equal(treasury.address);
      expect(await factory.feeBps()).to.equal(FEE_BPS);
      expect(await factory.implementation()).to.not.equal(ethers.ZeroAddress);
    });

    it("rechaza un fee mayor al 10% en el deploy", async function () {
      const [owner, treasury] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("SplitVaultFactory");

      await expect(
        Factory.deploy(owner.address, treasury.address, 1001)
      ).to.be.revertedWithCustomError(Factory, "FeeTooHigh");
    });

    it("rechaza una tesorería en address(0)", async function () {
      const [owner] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("SplitVaultFactory");

      await expect(
        Factory.deploy(owner.address, ethers.ZeroAddress, FEE_BPS)
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
});