import { constants, ethers, utils, providers } from 'ethers'
import { TypedDataSigner } from '@ethersproject/abstract-signer'
// Import from Safe contracts repo once fixed
import { MetaTransaction, SafeSignature, buildSignatureBytes } from './execution'
import { UserOperation } from './userOp'

const AddressOne = "0x0000000000000000000000000000000000000001";


const INTERFACES = new ethers.utils.Interface([
    'function enableModule(address)',
    'function setup(address[],uint256,address,bytes,address,address,uint256,address)',
    'function createProxyWithNonce(address,bytes,uint256) returns (address)',
    'function proxyCreationCode() returns (bytes)',
    'function enableModules(address[])',
    'function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bool success)',
    'function getNonce(address,uint192) returns (uint256 nonce)',
    'function supportedEntryPoint() returns (address)',
    'function getOwners() returns (address[])',
    'function getThreshold() view returns (uint256)',
    'function getModulesPaginated(address, uint256) returns (address[], address)',
    'function getOperationHash(address,bytes,uint256,uint256,uint256,uint256,uint256,uint256,address)'
])


const EIP712_SAFE_OPERATION_TYPE = {
    // "SafeOp(address safe,bytes callData,uint256 nonce,uint256 preVerificationGas,uint256 verificationGasLimit,uint256 callGasLimit,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,address entryPoint)"
    SafeOp: [
      { type: 'address', name: 'safe' },
      { type: 'bytes', name: 'callData' },
      { type: 'uint256', name: 'nonce' },
      { type: 'uint256', name: 'preVerificationGas' },
      { type: 'uint256', name: 'verificationGasLimit' },
      { type: 'uint256', name: 'callGasLimit' },
      { type: 'uint256', name: 'maxFeePerGas' },
      { type: 'uint256', name: 'maxPriorityFeePerGas' },
      { type: 'address', name: 'entryPoint' },
    ],
  }

export interface OperationParams {
    nonce: bigint,
    preVerificationGas: bigint,
    verificationGasLimit: bigint,
    callGasLimit: bigint,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint
}

export interface GlobalConfig {
    safeSingleton: string,
    entryPoint: string,
    erc4337module: string,
    proxyFactory: string,
    proxyCreationCode: string,
    addModulesLib: string,
    chainId: number
}

export interface SafeConfig {
    signers: string[]
    threshold: number,
    nonce: number
}

const calculateProxyAddress = (globalConfig: GlobalConfig, inititalizer: string, nonce: number | string): string => {
    const deploymentCode = ethers.utils.solidityPack(["bytes", "uint256"], [globalConfig.proxyCreationCode, globalConfig.safeSingleton]);
    const salt = ethers.utils.solidityKeccak256(["bytes32", "uint256"], [ethers.utils.solidityKeccak256(["bytes"], [inititalizer]), nonce]);
    return ethers.utils.getCreate2Address(globalConfig.proxyFactory, salt, ethers.utils.keccak256(deploymentCode));
  };

const buildInitParamsForConfig = (safeConfig: SafeConfig, globalConfig: GlobalConfig): { safeAddress: string, initCode: string } => {
    const initData = INTERFACES.encodeFunctionData("enableModules", [[globalConfig.erc4337module, globalConfig.entryPoint]])
    const setupData = INTERFACES.encodeFunctionData("setup", [
        safeConfig.signers, safeConfig.threshold, globalConfig.addModulesLib, initData, globalConfig.erc4337module, constants.AddressZero, 0, constants.AddressZero
    ])
    const deployData = INTERFACES.encodeFunctionData("createProxyWithNonce", [
        globalConfig.safeSingleton, setupData, safeConfig.nonce
    ])
    const safeAddress = calculateProxyAddress(globalConfig, setupData, safeConfig.nonce)
    const initCode = ethers.utils.solidityPack(["address", "bytes"], [globalConfig.proxyFactory, deployData])
    return {
        safeAddress,
        initCode
    }
}

const callInterface = async(provider: providers.Provider, contract: string, method: string, params: any[]): Promise<ethers.utils.Result> => {
  const result = await provider.call({ 
    to: contract, 
    data: INTERFACES.encodeFunctionData(method, params)
  })
  console.log(result)
  return INTERFACES.decodeFunctionResult(method, result)
}

const actionCalldata = (action: MetaTransaction): string => {
    return INTERFACES.encodeFunctionData(
        'execTransactionFromModule',
        [action.to, action.value, action.data, action.operation]
    )
}

export class MultiProvider4337 extends providers.JsonRpcProvider {
    generalProvider: providers.JsonRpcProvider
    constructor(aaProviderUrl: string, generalProvider: providers.JsonRpcProvider) {
        super(aaProviderUrl)
        this.generalProvider = generalProvider;
    }

    send(method: string, params: any[]): Promise<any> {
        if ([
            'eth_chainId',
            'eth_supportedEntryPoints',
            'eth_estimateUserOperationGas',
            'eth_sendUserOperation',
            'eth_getUserOperationByHash',
            'eth_getUserOperationReceipt'
        ].indexOf(method) >= 0) {
            return super.send(method, params);
        } else {
            return this.generalProvider.send(method, params)
        }
    }
}

export class Safe4337Operation {

    private safe: Safe4337
    private action: MetaTransaction
    private params: OperationParams
    private globalConfig: GlobalConfig
    private signatures: SafeSignature[] = []

    constructor(safe: Safe4337, action: MetaTransaction, params: OperationParams, globalConfig: GlobalConfig) {
        this.safe = safe;
        this.action = action;
        this.params = params;
        this.globalConfig = globalConfig
    }

    operationHash(): string {
        return utils._TypedDataEncoder.hash(
            { chainId: this.globalConfig.chainId, verifyingContract: this.globalConfig.erc4337module }, 
            EIP712_SAFE_OPERATION_TYPE, 
            {
                safe: this.safe.address,
                callData: actionCalldata(this.action),
                entryPoint: this.globalConfig.entryPoint,
                ...this.params
            }
        )
    }

    async encodedSignatures(): Promise<string> {
        return buildSignatureBytes(this.signatures)
    }

    async userOperation(paymasterAndData: string = "0x"): Promise<UserOperation> {
        const initCode = await this.safe.isDeployed() ? "0x" : this.safe.getInitCode()
        return {
            nonce: utils.hexlify(this.params.nonce),
            callData: actionCalldata(this.action),
            verificationGasLimit: utils.hexValue(this.params.verificationGasLimit),
            preVerificationGas: utils.hexlify(this.params.preVerificationGas),
            callGasLimit: utils.hexlify(this.params.callGasLimit),
            maxFeePerGas: utils.hexlify(this.params.maxFeePerGas),
            maxPriorityFeePerGas: utils.hexlify(this.params.maxPriorityFeePerGas),
            initCode,
            paymasterAndData,
            sender: this.safe.address,
            signature: await this.encodedSignatures(),
          }
    }

    async authorize(signer: ethers.Signer & TypedDataSigner) {
        const validSigners = await this.safe.getSigners()
        const signerAddress = await signer.getAddress()
        if (validSigners.indexOf(signerAddress) < 0) throw Error("Invalid Signer")
        if (this.signatures.findIndex((signature) => signature.signer === signerAddress) >= 0) throw Error("Already signed")
        this.signatures.push({
            signer: signerAddress,
            data: await signer._signTypedData(
                { chainId: this.globalConfig.chainId, verifyingContract: this.globalConfig.erc4337module }, 
                EIP712_SAFE_OPERATION_TYPE, 
                {
                    safe: this.safe.address,
                    callData: actionCalldata(this.action),
                    entryPoint: this.globalConfig.entryPoint,
                    ...this.params
                }
            )
        }) 
        console.log(this.signatures)
    }

    static async build(provider: providers.JsonRpcProvider, safe: Safe4337, action: MetaTransaction, globalConfig: GlobalConfig): Promise<Safe4337Operation> {
        const initCode = await safe.isDeployed() ? "0x" : safe.getInitCode()
        const nonce = (await callInterface(provider, globalConfig.entryPoint, "getNonce", [safe.address, 0]))[0]
        const estimateOperation = {
            sender: safe.address,
            callData: actionCalldata(action),
            paymasterAndData: "0x",
            nonce: utils.hexlify(nonce),
            initCode,
            signature: "0x".padEnd(130, "a"),
            // For some providers we need to set some really high values to allow estimation
            preVerificationGas: utils.hexlify(1000000),
            verificationGasLimit: utils.hexlify(1000000),
            callGasLimit: utils.hexlify(10000000),
            // To keep the required funds low, the gas fee is set close to the minimum
            maxFeePerGas: "0x10",
            maxPriorityFeePerGas: "0x10",
        }
        const estimates = await provider.send('eth_estimateUserOperationGas', [{
            ...estimateOperation
          }, globalConfig.entryPoint])
        console.log(estimates)

        const feeData = await provider.getFeeData()
        const params: OperationParams = {
            nonce,
            maxFeePerGas: feeData.maxFeePerGas!!.toBigInt(),
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!!.toBigInt(),
            // Add a small margin as some dataoverhead calculation is not always accurate
            preVerificationGas: BigInt(estimates.preVerificationGas) + BigInt(1000),
            // Add 20% to the gas limits to account for inaccurate estimations
            verificationGasLimit: BigInt(estimates.verificationGasLimit) * BigInt(12) / BigInt(10),
            callGasLimit: BigInt(estimates.callGasLimit) * BigInt(12) / BigInt(10),
        }
        return new Safe4337Operation(safe, action, params, globalConfig)
    }
}

export class Safe4337 {

    public address: string;
    private globalConfig: GlobalConfig;
    private safeConfig: SafeConfig | undefined;
    private provider: providers.JsonRpcProvider | undefined;

    constructor(address: string, globalConfig: GlobalConfig, safeConfig?: SafeConfig) {
        if (safeConfig) {
            const initParams = buildInitParamsForConfig(safeConfig, globalConfig)
            if (address !== initParams.safeAddress) throw Error("Invalid configs");
        }
        this.address = address;
        this.globalConfig = globalConfig;
        this.safeConfig = safeConfig
    }

    connect(provider: providers.JsonRpcProvider): Safe4337 {
        this.provider = provider;
        return this;
    }

    disconnect() {
        this.provider = undefined;
    }

    async isDeployed(): Promise<boolean> {
        if (!this.provider) throw Error("Not connected!");

        const code = await this.provider.getCode(this.address, "latest");
        return code !== '0x';
    }

    getInitCode(): string {
        if (!this.safeConfig) throw Error("Init code not available");
        const initParams = buildInitParamsForConfig(this.safeConfig, this.globalConfig);
        return initParams.initCode;
    }

    async getSigners(): Promise<string[]> {
        if (!await this.isDeployed()) {
            if (!this.safeConfig) throw Error("Not deployed and no config available");
            return this.safeConfig.signers;
        }
        const result = await callInterface(this.provider!!, this.address, "getOwners", [])
        return result[0]
    }

    async getModules(): Promise<string[]> {
        if (!await this.isDeployed()) {
            if (!this.safeConfig) throw Error("Not deployed and no config available");
            return [this.globalConfig.erc4337module, this.globalConfig.entryPoint];
        }
        const result = await callInterface(this.provider!!, this.address, "getModulesPaginated", [AddressOne, 10])
        return result[0]
    }

    async getThreshold(): Promise<number> {
        if (!await this.isDeployed()) {
            if (!this.safeConfig) throw Error("Not deployed and no config available");
            return this.safeConfig.threshold;
        }
        const result = await callInterface(this.provider!!, this.address, "getThreshold", [])
        return result[0]
    }

    async operate(action: MetaTransaction): Promise<Safe4337Operation> {
        if (!this.provider) throw Error("Missing provider")
        return Safe4337Operation.build(
            this.provider, this, action, this.globalConfig
        )
    }

    static async withSigner(signer: string, globalConfig: GlobalConfig): Promise<Safe4337> {
        const safeConfig: SafeConfig = {
            signers: [signer],
            threshold: 1,
            nonce: 0
        }
        return Safe4337.withConfigs(safeConfig, globalConfig)
    }

    static async withConfigs(safeConfig: SafeConfig, globalConfig: GlobalConfig): Promise<Safe4337> {
        const initParams = buildInitParamsForConfig(safeConfig, globalConfig)
        return new Safe4337(initParams.safeAddress, globalConfig, safeConfig)
    } 
}