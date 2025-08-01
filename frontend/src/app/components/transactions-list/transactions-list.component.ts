import { Component, OnInit, Input, ChangeDetectionStrategy, OnChanges, Output, EventEmitter, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { StateService, SignaturesMode } from '@app/services/state.service';
import { CacheService } from '@app/services/cache.service';
import { Observable, ReplaySubject, BehaviorSubject, merge, Subscription, of, forkJoin } from 'rxjs';
import { Outspend, Transaction, Vin, Vout } from '@interfaces/electrs.interface';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { environment } from '@environments/environment';
import { AssetsService } from '@app/services/assets.service';
import { filter, map, tap, switchMap, catchError } from 'rxjs/operators';
import { BlockExtended } from '@interfaces/node-api.interface';
import { ApiService } from '@app/services/api.service';
import { PriceService } from '@app/services/price.service';
import { StorageService } from '@app/services/storage.service';
import { OrdApiService } from '@app/services/ord-api.service';
import { Inscription } from '@app/shared/ord/inscription.utils';
import { Etching, Runestone } from '@app/shared/ord/rune.utils';
import { ADDRESS_SIMILARITY_THRESHOLD, AddressMatch, AddressSimilarity, AddressType, AddressTypeInfo, checkedCompareAddressStrings, detectAddressType } from '@app/shared/address-utils';
import { processInputSignatures, Sighash, SigInfo, SighashLabels } from '@app/shared/transaction.utils';
import { ActivatedRoute } from '@angular/router';
import { SighashFlag } from '@app/shared/transaction.utils';

@Component({
  selector: 'app-transactions-list',
  templateUrl: './transactions-list.component.html',
  styleUrls: ['./transactions-list.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TransactionsListComponent implements OnInit, OnChanges, OnDestroy {
  network = '';
  nativeAssetId = this.stateService.network === 'liquidtestnet' ? environment.nativeTestAssetId : environment.nativeAssetId;
  isLiquid = this.stateService.network === 'liquid' || this.stateService.network === 'liquidtestnet';
  showMoreIncrement = 1000;

  @Input() transactions: Transaction[];
  @Input() cached: boolean = false;
  @Input() showConfirmations = false;
  @Input() transactionPage = false;
  @Input() errorUnblinded = false;
  @Input() paginated = false;
  @Input() inputIndex: number;
  @Input() outputIndex: number;
  @Input() addresses: string[] = [];
  @Input() rowLimit = 12;
  @Input() blockTime: number = 0; // Used for price calculation if all the transactions are in the same block
  @Input() txPreview = false;
  @Input() forceSignaturesMode: SignaturesMode = null;

  @Output() loadMore = new EventEmitter();

  latestBlock$: Observable<BlockExtended>;
  outspendsSubscription: Subscription;
  currencyChangeSubscription: Subscription;
  networkSubscription: Subscription;
  signaturesSubscription: Subscription;
  queryParamsSubscription: Subscription;
  currency: string;
  refreshOutspends$: ReplaySubject<string[]> = new ReplaySubject();
  refreshChannels$: ReplaySubject<string[]> = new ReplaySubject();
  showDetails$ = new BehaviorSubject<boolean>(false);
  assetsMinimal: any;
  transactionsLength: number = 0;
  inputRowLimit: number = 12;
  outputRowLimit: number = 12;
  showFullScript: { [vinIndex: number]: boolean } = {};
  showFullWitness: { [vinIndex: number]: { [witnessIndex: number]: boolean } } = {};
  showFullScriptPubkeyAsm: { [voutIndex: number]: boolean } = {};
  showFullScriptPubkeyHex: { [voutIndex: number]: boolean } = {};
  showFullOpReturnData: { [voutIndex: number]: boolean } = {};
  showFullOpReturnPreview: { [voutIndex: number]: boolean } = {};
  showOrdData: { [key: string]: { show: boolean; inscriptions?: Inscription[]; runestone?: Runestone, runeInfo?: { [id: string]: { etching: Etching; txid: string; } }; } } = {};
  similarityMatches: Map<string, Map<string, { score: number, match: AddressMatch, group: number }>> = new Map();

  selectedSig: { txIndex: number, vindex: number, sig: SigInfo } | null = null;
  sigHighlights: { vin: boolean[], vout: boolean[] } = { vin: [], vout: [] };
  sighashLabels = SighashLabels;

  signaturesPreference: SignaturesMode = null;
  signaturesOverride: SignaturesMode = null;
  signaturesMode: SignaturesMode = 'interesting';

  constructor(
    public stateService: StateService,
    private cacheService: CacheService,
    private electrsApiService: ElectrsApiService,
    private apiService: ApiService,
    private ordApiService: OrdApiService,
    private assetsService: AssetsService,
    private ref: ChangeDetectorRef,
    private priceService: PriceService,
    private storageService: StorageService,
    private route: ActivatedRoute,
  ) {
    this.signaturesMode = this.forceSignaturesMode || this.stateService.signaturesMode$.value;
  }

  ngOnInit(): void {
    this.latestBlock$ = this.stateService.blocks$.pipe(map((blocks) => blocks[0]));
    this.networkSubscription = this.stateService.networkChanged$.subscribe((network) => {
      this.network = network;
      this.isLiquid = network === 'liquid' || network === 'liquidtestnet';
    });

    this.signaturesSubscription = this.stateService.signaturesMode$.subscribe((mode) => {
      this.signaturesPreference = mode;
      this.updateSignaturesMode();
    });

    this.queryParamsSubscription = this.route.queryParams.subscribe((params) => {
      if (params['sigs'] && ['all', 'interesting', 'none'].includes(params['sigs'])) {
        this.signaturesOverride = params['sigs'] as SignaturesMode;
        this.updateSignaturesMode();
      } else {
        this.signaturesOverride = null;
        this.updateSignaturesMode();
      }
    });

    if (this.network === 'liquid' || this.network === 'liquidtestnet') {
      this.assetsService.getAssetsMinimalJson$.subscribe((assets) => {
        this.assetsMinimal = assets;
      });
    }

    this.outspendsSubscription = merge(
      this.refreshOutspends$
        .pipe(
          switchMap((txIds) => {
            if (!this.cached && !this.txPreview) {
              // break list into batches of 50 (maximum supported by esplora)
              const batches = [];
              for (let i = 0; i < txIds.length; i += 50) {
                batches.push(txIds.slice(i, i + 50));
              }
              return forkJoin(batches.map(batch => { return this.electrsApiService.cachedRequest(this.electrsApiService.getOutspendsBatched$, 250, batch); }));
            } else {
              return of([]);
            }
          }),
          tap((batchedOutspends: Outspend[][][]) => {
            // flatten batched results back into a single array
            const outspends = batchedOutspends.flat(1);
            if (!this.transactions) {
              return;
            }
            const transactions = this.transactions.filter((tx) => !tx._outspends);
            outspends.forEach((outspend, i) => {
              transactions[i]._outspends = outspend;
            });
            this.ref.markForCheck();
          }),
        ),
      this.stateService.utxoSpent$
        .pipe(
          tap((utxoSpent) => {
            for (const i in utxoSpent) {
              this.transactions[0]._outspends[i] = {
                spent: true,
                txid: utxoSpent[i].txid,
                vin: utxoSpent[i].vin,
              };
            }
          }),
        ),
        this.refreshChannels$
          .pipe(
            filter(() => this.stateService.networkSupportsLightning() && !this.txPreview),
            switchMap((txIds) => this.apiService.getChannelByTxIds$(txIds)),
            catchError((error) => {
              // handle 404
              return of([]);
            }),
            tap((channels) => {
              if (!this.transactions) {
                return;
              }
              const transactions = this.transactions.filter((tx) => !tx._channels);
              channels.forEach((channel, i) => {
                transactions[i]._channels = channel;
              });
            }),
          )
        ,
    ).subscribe(() => this.ref.markForCheck());

    this.currencyChangeSubscription = this.stateService.fiatCurrency$
    .subscribe(currency => {
      this.currency = currency;
      this.refreshPrice();
    });

    this.updateAddressSimilarities();
  }

  refreshPrice(): void {
    // Loop over all transactions
    if (!this.transactions || !this.transactions.length || !this.currency) {
      return;
    }
    const confirmedTxs = this.transactions.filter((tx) => tx.status.confirmed).length;
    if (!this.blockTime) {
      this.transactions.forEach((tx) => {
        if (!this.blockTime) {
          if (tx.status.block_time) {
            this.priceService.getBlockPrice$(tx.status.block_time, confirmedTxs < 3, this.currency).pipe(
              tap((price) => tx['price'] = price),
            ).subscribe();
          }
        }
      });
    } else {
      this.priceService.getBlockPrice$(this.blockTime, true, this.currency).pipe(
        tap((price) => this.transactions?.forEach((tx) => tx['price'] = price)),
      ).subscribe();
    }
  }

  ngOnChanges(changes): void {
    if (changes.inputIndex || changes.outputIndex || changes.rowLimit) {
      this.inputRowLimit = Math.max(this.rowLimit, (this.inputIndex || 0) + 3);
      this.outputRowLimit = Math.max(this.rowLimit, (this.outputIndex || 0) + 3);
      if ((this.inputIndex || this.outputIndex) && !changes.transactions) {
        setTimeout(() => {
          const assetBoxElements = document.getElementsByClassName('assetBox');
          if (assetBoxElements && assetBoxElements[0]) {
            assetBoxElements[0].scrollIntoView({block: "center"});
          }
        }, 10);
      }
    }
    if (changes.transactions || changes.addresses) {
      this.similarityMatches.clear();
      this.updateAddressSimilarities();
      if (!this.transactions || !this.transactions.length) {
        return;
      }

      this.transactionsLength = this.transactions.length;

      if (!this.txPreview) {
        this.cacheService.setTxCache(this.transactions);
      }

      const confirmedTxs = this.transactions.filter((tx) => tx.status.confirmed).length;

      this.transactions.forEach((tx) => {
        tx['@voutLimit'] = true;
        tx['@vinLimit'] = true;
        tx['_showSignatures'] = false;
        tx['_interestingSignatures'] = false;

        if (this.addresses?.length) {
          const addressIn = tx.vout.map(v => {
            for (const address of this.addresses) {
              switch (address.length) {
                case 130: {
                  if (v.scriptpubkey === '41' + address + 'ac') {
                    return v.value;
                  }
                } break;
                case 66: {
                  if (v.scriptpubkey === '21' + address + 'ac') {
                    return v.value;
                  }
                } break;
                default:{
                  if (v.scriptpubkey_address === address) {
                    return v.value;
                  }
                } break;
              }
            }
            return 0;
          }).reduce((acc, v) => acc + v, 0);
          const addressOut = tx.vin.map(v => {
            for (const address of this.addresses) {
              switch (address.length) {
                case 130: {
                  if (v.prevout?.scriptpubkey === '41' + address + 'ac') {
                    return v.prevout?.value;
                  }
                } break;
                case 66: {
                  if (v.prevout?.scriptpubkey === '21' + address + 'ac') {
                    return v.prevout?.value;
                  }
                } break;
                default:{
                  if (v.prevout?.scriptpubkey_address === address) {
                    return v.prevout?.value;
                  }
                } break;
              }
            }
            return 0;
          }).reduce((acc, v) => acc + v, 0);
          tx['addressValue'] = addressIn - addressOut;
        }

        if (!this.blockTime && tx.status.block_time && this.currency) {
          this.priceService.getBlockPrice$(tx.status.block_time, confirmedTxs < 3, this.currency).pipe(
            tap((price) => tx['price'] = price),
          ).subscribe();
        }

        // Check for ord data fingerprints in inputs and outputs
        if (this.stateService.network !== 'liquid' && this.stateService.network !== 'liquidtestnet') {
          for (let i = 0; i < tx.vin.length; i++) {
            if (tx.vin[i].prevout?.scriptpubkey_type === 'v1_p2tr' && tx.vin[i].witness?.length) {
              const hasAnnex = tx.vin[i].witness?.[tx.vin[i].witness.length - 1].startsWith('50');
              if (tx.vin[i].witness.length > (hasAnnex ? 2 : 1) && tx.vin[i].witness[tx.vin[i].witness.length - (hasAnnex ? 3 : 2)].includes('0063036f7264')) {
                tx.vin[i].isInscription = true;
                tx.largeInput = true;
              }
            }
          }
          for (let i = 0; i < tx.vout.length; i++) {
            if (tx.vout[i]?.scriptpubkey?.startsWith('6a5d')) {
              tx.vout[i].isRunestone = true;
              break;
            }
          }

          // process signature data
          if (tx.vin.length && !tx.vin[0].is_coinbase) {
            tx['_sigs'] = tx.vin.map(vin => processInputSignatures(vin));
            tx['_sigmap'] = tx['_sigs'].reduce((map, sigs, vindex) => {
              sigs.forEach(sig => {
                map[sig.signature] = { sig, vindex };
              });
              return map;
            }, {});

            if (!tx['_interestingSignatures']) {
              tx['_interestingSignatures'] = tx['_sigs'].some(sigs => sigs.some(sig => this.sigIsInteresting(sig)))
                || tx['_sigs'].every(sigs => !sigs?.length);
            }
          }
          tx['_showSignatures'] = this.shouldShowSignatures(tx);
        } else { // check for simplicity script spends
          for (const vin of tx.vin) {
            if (vin.prevout?.scriptpubkey_type === 'v1_p2tr' && vin.inner_witnessscript_asm) {
              const hasAnnex = vin.witness[vin.witness.length - 1].startsWith('50');
              const isScriptSpend = vin.witness.length > (hasAnnex ? 2 : 1);
              if (isScriptSpend) {
                const controlBlock = hasAnnex ? vin.witness[vin.witness.length - 2] : vin.witness[vin.witness.length - 1];
                const scriptHex = hasAnnex ? vin.witness[vin.witness.length - 3] : vin.witness[vin.witness.length - 2]; // bip341 script element
                const tapleafVersion = parseInt(controlBlock.slice(0, 2), 16) & 0xfe;
                // simplicity script spend
                if (tapleafVersion === 0xbe) {
                  vin.inner_simplicityscript = vin.witness[1]; // simplicity program is the second witness element
                }
              }
            }
          }
        }

        tx.largeInput = tx.largeInput || tx.vin.some(vin => (vin?.prevout?.value > 1000000000));
        tx.largeOutput = tx.vout.some(vout => (vout?.value > 1000000000));
      });

      if (this.blockTime && this.transactions?.length && this.currency) {
        this.priceService.getBlockPrice$(this.blockTime, true, this.currency).pipe(
          tap((price) => this.transactions?.forEach((tx) => tx['price'] = price)),
        ).subscribe();
      }
      const txIds = this.transactions.filter((tx) => !tx._outspends).map((tx) => tx.txid);
      if (txIds.length && !this.cached) {
        this.refreshOutspends$.next(txIds);
      }
      if (this.stateService.networkSupportsLightning()) {
        const txIds = this.transactions.filter((tx) => !tx._channels).map((tx) => tx.txid);
        if (txIds.length) {
          this.refreshChannels$.next(txIds);
        }
      }
    }
  }

  updateAddressSimilarities(): void {
    if (!this.transactions || !this.transactions.length) {
      return;
    }
    for (const tx of this.transactions) {
      if (this.similarityMatches.get(tx.txid)) {
        continue;
      }

      const similarityGroups: Map<string, number> = new Map();
      let lastGroup = 0;

      // Check for address poisoning similarity matches
      this.similarityMatches.set(tx.txid, new Map());
      const comparableVouts = tx.vout.slice(0, 20).filter(v => ['p2pkh', 'p2sh', 'v0_p2wpkh', 'v0_p2wsh', 'v1_p2tr'].includes(v.scriptpubkey_type));
      const comparableVins = tx.vin.slice(0, 20).map(v => v.prevout).filter(v => ['p2pkh', 'p2sh', 'v0_p2wpkh', 'v0_p2wsh', 'v1_p2tr'].includes(v?.scriptpubkey_type));
      for (const vout of comparableVouts) {
        const address = vout.scriptpubkey_address;
        const addressType = vout.scriptpubkey_type;
        if (this.similarityMatches.get(tx.txid)?.has(address)) {
          continue;
        }
        for (const compareAddr of [
          ...comparableVouts.filter(v => v.scriptpubkey_type === addressType && v.scriptpubkey_address !== address),
          ...comparableVins.filter(v => v.scriptpubkey_type === addressType && v.scriptpubkey_address !== address)
        ]) {
          const similarity = checkedCompareAddressStrings(address, compareAddr.scriptpubkey_address, addressType as AddressType, this.stateService.network);
          if (similarity?.status === 'comparable' && similarity.score > ADDRESS_SIMILARITY_THRESHOLD) {
            let group = similarityGroups.get(address) || lastGroup++;
            similarityGroups.set(address, group);
            const bestVout = this.similarityMatches.get(tx.txid)?.get(address);
            if (!bestVout || bestVout.score < similarity.score) {
              this.similarityMatches.get(tx.txid)?.set(address, { score: similarity.score, match: similarity.left, group });
            }
            // opportunistically update the entry for the compared address
            const bestCompare = this.similarityMatches.get(tx.txid)?.get(compareAddr.scriptpubkey_address);
            if (!bestCompare || bestCompare.score < similarity.score) {
              group = similarityGroups.get(compareAddr.scriptpubkey_address) || lastGroup++;
              similarityGroups.set(compareAddr.scriptpubkey_address, group);
              this.similarityMatches.get(tx.txid)?.set(compareAddr.scriptpubkey_address, { score: similarity.score, match: similarity.right, group });
            }
          }
        }
      }
    }
  }

  onScroll(): void {
    this.loadMore.emit();
  }

  haveBlindedOutputValues(tx: Transaction): boolean {
    return tx.vout.some((v: any) => v.value === undefined);
  }

  getTotalTxOutput(tx: Transaction): number {
    return tx.vout.map((v: Vout) => v.value || 0).reduce((a: number, b: number) => a + b);
  }

  switchCurrency(): void {
    if (this.network === 'liquid' || this.network === 'liquidtestnet') {
      return;
    }
    const modes = ['btc', 'sats', 'fiat'];
    const oldIndex = modes.indexOf(this.stateService.viewAmountMode$.value);
    const newIndex = (oldIndex + 1) % modes.length;
    this.stateService.viewAmountMode$.next(modes[newIndex] as 'btc' | 'sats' | 'fiat');
    this.storageService.setValue('view-amount-mode', modes[newIndex]);
  }

  trackByFn(index: number, tx: Transaction): string {
    return tx.txid + tx.status.confirmed;
  }

  trackByIndexFn(index: number): number {
    return index;
  }

  formatHex(num: number): string {
    const str = num.toString(16);
    return '0x' + (str.length % 2 ? '0' : '') + str;
  }

  pow(base: number, exponent: number): number {
    return Math.pow(base, exponent);
  }

  toggleDetails(): void {
    if (this.showDetails$.value === true) {
      this.showDetails$.next(false);
      this.showFullScript = {};
      this.showFullWitness = {};
    } else {
      this.showFullScript = this.transactions[0] ? this.transactions[0].vin.reduce((acc, _, i) => ({...acc, [i]: false}), {}) : {};
      this.showFullWitness = this.transactions[0] ? this.transactions[0].vin.reduce((acc, vin, vinIndex) => {
        acc[vinIndex] = vin.witness ? vin.witness.reduce((witnessAcc, _, witnessIndex) => {
          witnessAcc[witnessIndex] = false;
          return witnessAcc;
        }, {}) : {};
        return acc;
      }, {}) : {};
      this.showDetails$.next(true);
    }
  }

  loadMoreInputs(tx: Transaction): void {
    if (!tx['@vinLoaded'] && !this.txPreview) {
      this.electrsApiService.getTransaction$(tx.txid)
        .subscribe((newTx) => {
          tx['@vinLoaded'] = true;
          let temp = tx.vin;
          tx.vin = newTx.vin;
          tx.fee = newTx.fee;
          for (const [index, vin] of temp.entries()) {
            newTx.vin[index].isInscription = vin.isInscription;
          }
          this.ref.markForCheck();
        });
    }
  }

  showMoreInputs(tx: Transaction): void {
    this.loadMoreInputs(tx);
    tx['@vinLimit'] = this.getVinLimit(tx, true);
  }

  showMoreOutputs(tx: Transaction): void {
    tx['@voutLimit'] = this.getVoutLimit(tx, true);
  }

  getVinLimit(tx: Transaction, next = false): number {
    let limit;
    if ((tx['@vinLimit'] || 0) > this.inputRowLimit) {
      limit = Math.min(tx['@vinLimit'] + (next ? this.showMoreIncrement : 0), tx.vin.length);
    } else {
      limit = Math.min((next ? this.showMoreIncrement : this.inputRowLimit), tx.vin.length);
    }
    if (tx.vin.length - limit <= 5) {
      limit = tx.vin.length;
    }
    return limit;
  }

  getVoutLimit(tx: Transaction, next = false): number {
    let limit;
    if ((tx['@voutLimit'] || 0) > this.outputRowLimit) {
      limit = Math.min(tx['@voutLimit'] + (next ? this.showMoreIncrement : 0), tx.vout.length);
    } else {
      limit = Math.min((next ? this.showMoreIncrement : this.outputRowLimit), tx.vout.length);
    }
    if (tx.vout.length - limit <= 5) {
      limit = tx.vout.length;
    }
    return limit;
  }

  toggleShowFullScript(vinIndex: number): void {
    this.showFullScript[vinIndex] = !this.showFullScript[vinIndex];
  }

  toggleShowFullWitness(vinIndex: number, witnessIndex: number): void {
    this.showFullWitness[vinIndex][witnessIndex] = !this.showFullWitness[vinIndex][witnessIndex];
  }

  toggleShowFullScriptPubkeyAsm(voutIndex: number): void {
    this.showFullScriptPubkeyAsm[voutIndex] = !this.showFullScriptPubkeyAsm[voutIndex];
  }

  toggleShowFullScriptPubkeyHex(voutIndex: number): void {
    this.showFullScriptPubkeyHex[voutIndex] = !this.showFullScriptPubkeyHex[voutIndex];
  }

  toggleShowFullOpReturnData(voutIndex: number): void {
    this.showFullOpReturnData[voutIndex] = !this.showFullOpReturnData[voutIndex];
  }

  toggleShowFullOpReturnPreview(voutIndex: number): void {
    this.showFullOpReturnPreview[voutIndex] = !this.showFullOpReturnPreview[voutIndex];
  }

  toggleOrdData(txid: string, type: 'vin' | 'vout', index: number) {
    const tx = this.transactions.find((tx) => tx.txid === txid);
    if (!tx) {
      return;
    }

    const key = tx.txid + '-' + type + '-' + index;
    this.showOrdData[key] = this.showOrdData[key] || { show: false };

    if (type === 'vin') {

      if (!this.showOrdData[key].inscriptions) {
        const hasAnnex = tx.vin[index].witness?.[tx.vin[index].witness.length - 1].startsWith('50');
        this.showOrdData[key].inscriptions = this.ordApiService.decodeInscriptions(tx.vin[index].witness[tx.vin[index].witness.length - (hasAnnex ? 3 : 2)]);
      }
      this.showOrdData[key].show = !this.showOrdData[key].show;

    } else if (type === 'vout') {

      if (!this.showOrdData[key].runestone) {
        this.ordApiService.decodeRunestone$(tx).pipe(
          tap((runestone) => {
            if (runestone) {
              Object.assign(this.showOrdData[key], runestone);
              this.ref.markForCheck();
            }
          }),
        ).subscribe();
      }
      this.showOrdData[key].show = !this.showOrdData[key].show;

    }
  }

  showSigInfo(txIndex: number, vindex: number, sig: SigInfo): void {
    this.selectedSig = { txIndex, vindex, sig };
    this.sigHighlights = { vin: [], vout: [] };
    for (let i = 0; i < this.transactions[txIndex].vin.length; i++) {
      this.sigHighlights.vin.push(
        i === vindex ||
        !(Sighash.isACP(sig.sighash))
      );
    }
    for (let i = 0; i < this.transactions[txIndex].vout.length; i++) {
      this.sigHighlights.vout.push(
        !(Sighash.isNone(sig.sighash)) && (
          !(Sighash.isSingle(sig.sighash)) ||
          i === vindex
        )
      );
    }
    this.ref.markForCheck();
  }

  hideSigInfo(): void {
    this.selectedSig = null;
    this.sigHighlights = { vin: [], vout: [] };
    this.ref.markForCheck();
  }

  updateSignaturesMode(): void {
    this.signaturesMode = this.signaturesOverride || this.forceSignaturesMode || this.signaturesPreference || 'interesting';
    if (this.transactions?.length) {
      for (const tx of this.transactions) {
        tx['_showSignatures'] = this.shouldShowSignatures(tx);
      }
    }
  }

  showSig(sigs: SigInfo[]): boolean {
    return this.signaturesMode === 'all' || (this.signaturesMode === 'interesting' && sigs.some(sig => this.sigIsInteresting(sig)));
  }

  sigIsInteresting(sig: SigInfo): boolean {
    return sig.sighash !== SighashFlag.DEFAULT && sig.sighash !== SighashFlag.ALL;
  }

  shouldShowSignatures(tx): boolean {
    switch (this.signaturesMode) {
      case 'all':
        return true;
      case 'interesting':
        return tx['_interestingSignatures'];
      default:
        return false;
    }
  }

  ngOnDestroy(): void {
    this.outspendsSubscription.unsubscribe();
    this.currencyChangeSubscription?.unsubscribe();
    this.networkSubscription.unsubscribe();
    this.signaturesSubscription.unsubscribe();
  }
}
